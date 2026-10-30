package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync/atomic"
	"testing"
	"time"
)

func TestDiskCommandProcess(t *testing.T) {
	if os.Getenv("HAPPIER_TEST_DISK_COMMAND") == "" {
		return
	}
	if os.Getenv("HAPPIER_TEST_DISK_MEASURE_COST") != "" {
		var opened atomic.Int64
		diskOpenDirectoryForScan = func(path string) (diskDirectory, error) { opened.Add(1); return diskOpenRoot(path) }
		var request diskMeasureRequest
		if err := diskDecodeRequest(os.Stdin, &request); err != nil {
			t.Fatal(err)
		}
		started := time.Now()
		result, err := diskMeasure(context.Background(), request)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(os.Stderr, "MEASURE_COST elapsedMs=%f directories=%d\n", float64(time.Since(started).Microseconds())/1000, opened.Load())
		os.Exit(0)
	}
	if blocked := os.Getenv("HAPPIER_TEST_DISK_BLOCK"); blocked != "" {
		diskOpenDirectoryForScan = func(path string) (diskDirectory, error) {
			dir, err := diskOpenRoot(path)
			if err == nil && (path == blocked || path == os.Getenv("HAPPIER_TEST_DISK_PENDING_BLOCK")) {
				return diskBlockingDirectory{diskDirectory: dir}, nil
			}
			return dir, err
		}
	}
	os.Args = []string{os.Args[0], os.Getenv("HAPPIER_TEST_DISK_COMMAND")}
	main()
	os.Exit(0)
}

// A cancellable OS enumeration lets the real stream observe healthy work,
// elapsed inactivity and recovery without leaving a test worker alive.
type diskProgressBatchDirectory struct {
	diskDirectory
	release <-chan struct{}
}

func (dir diskProgressBatchDirectory) entryBatches(ctx context.Context, visit func([]diskEntry) error) (string, error) {
	select {
	case <-ctx.Done():
		return "fixture", ctx.Err()
	case <-dir.release:
	}
	entries, backend, err := dir.diskDirectory.entries(ctx)
	if err != nil {
		return backend, err
	}
	if err := visit(entries); err != nil {
		return backend, err
	}
	<-ctx.Done()
	return backend, ctx.Err()
}

func TestDiskScanPublishesOnlyStuckTransitionWhenFolderDoesNotChange(t *testing.T) {
	root := storageRenameTestRoot(t)
	scratch := storageRenameTestRoot(t)
	start := time.Unix(1_700_000_000, 0)
	var clock atomic.Int64
	clock.Store(start.UnixMilli())
	originalOpen, originalNow, originalTicks := diskOpenDirectoryForScan, diskScanNow, diskScanProgressTicks
	ticks := make(chan time.Time)
	opened, release := make(chan struct{}), make(chan struct{})
	diskScanNow = func() time.Time { return time.UnixMilli(clock.Load()) }
	// The real OS clock and directory enumeration are the only controlled boundaries.
	diskScanProgressTicks = func() (<-chan time.Time, func()) { return ticks, func() {} }
	diskOpenDirectoryForScan = func(path string) (diskDirectory, error) {
		dir, err := diskOpenRoot(path)
		if err == nil && path == root {
			close(opened)
			return diskProgressBatchDirectory{dir, release}, nil
		}
		return dir, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	progress := make(chan diskProgress, 8)
	done := make(chan error, 1)
	go func() {
		done <- diskScanStream(ctx, &diskControl{skipped: map[string]bool{}, changed: make(chan struct{}, 1)},
			diskScanRequest{Root: root, ScratchDirectory: scratch}, func(value any) error {
				if record, ok := value.(diskProgress); ok {
					progress <- record
				}
				return nil
			})
		close(done)
	}()
	defer func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("scan failed: %v", err)
		}
		diskOpenDirectoryForScan, diskScanNow, diskScanProgressTicks = originalOpen, originalNow, originalTicks
	}()
	select {
	case <-opened:
	case err := <-done:
		t.Fatalf("directory never entered: %v", err)
	}
	advance := func(elapsed time.Duration) []diskProgress {
		clock.Store(start.Add(elapsed).UnixMilli())
		// The second unbuffered tick establishes completion of the first; its
		// identical clock value cannot introduce another progress transition.
		for range 2 {
			select {
			case ticks <- start.Add(elapsed):
			case <-ctx.Done():
				t.Fatal("scan stopped consuming clock ticks")
			}
		}
		var records []diskProgress
		for {
			select {
			case record := <-progress:
				records = append(records, record)
			default:
				return records
			}
		}
	}
	if records := advance(0); len(records) != 1 || records[0].CurrentPath != diskPathID(root) || records[0].StuckSinceMs != 0 {
		t.Fatalf("missing initial progress: %#v", records)
	}
	if records := advance(9 * time.Second); len(records) != 0 {
		t.Errorf("unchanged folder republished before stuck: %#v", records)
	}
	if records := advance(10 * time.Second); len(records) != 1 || records[0].StuckSinceMs != start.UnixMilli() {
		t.Errorf("expected one ten-second stuck transition: %#v", records)
	}
	if records := advance(11 * time.Second); len(records) != 0 {
		t.Errorf("unchanged stuck folder republished: %#v", records)
	}
}

func TestDiskScanPublishesFinishedFoldersBeforeParentCompletes(t *testing.T) {
	root := storageRenameTestRoot(t)
	finished, blocked := filepath.Join(root, "finished"), filepath.Join(root, "blocked")
	for _, path := range []string{finished, blocked} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(finished, "data"), bytes.Repeat([]byte("x"), 8192), 0600); err != nil {
		t.Fatal(err)
	}
	originalOpen := diskOpenDirectoryForScan
	release := make(chan struct{})
	diskOpenDirectoryForScan = func(path string) (diskDirectory, error) {
		dir, err := diskOpenRoot(path)
		if err == nil && path == blocked {
			return diskProgressBatchDirectory{dir, release}, nil
		}
		return dir, err
	}
	defer func() { diskOpenDirectoryForScan = originalOpen }()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Stop accepting output after the useful folder completes. Like SIGKILL,
	// this forbids a terminal replay from repairing
	// an otherwise invisible completed folder after the cancellation boundary.
	stopped := errors.New("fixture transport closed")
	visible, enumerated, completed := false, false, false
	err := diskScanStream(ctx, &diskControl{skipped: map[string]bool{}, changed: make(chan struct{}, 1)},
		diskScanRequest{Root: root, ScratchDirectory: storageRenameTestRoot(t), DrawableNodes: 203}, func(value any) error {
			switch record := value.(type) {
			case diskEntryRecord:
				if record.Parent == diskPathID(root) && record.Node.ID == diskPathID(finished) {
					visible = record.Visible
				}
			case diskDirRecord:
				if record.ID == diskPathID(root) && record.Enumerated && !record.Complete {
					enumerated = true
					if !record.Flags.AtLeast {
						t.Error("partial root size is not marked at least")
					}
				}
				if record.ID == diskPathID(finished) && record.Complete {
					completed = true
					if record.AllocatedBytes < 8192 || record.Flags.AtLeast {
						t.Errorf("finished size is not usable: %#v", record)
					}
				}
			}
			if _, progress := value.(diskProgress); progress && completed {
				return stopped
			}
			return nil
		})
	if !errors.Is(err, stopped) || !visible || !enumerated || !completed {
		t.Fatalf("finished folder unavailable before parent completion: visible=%v enumerated=%v completed=%v err=%v", visible, enumerated, completed, err)
	}
}

func TestDiskScanProgressClearsStallOnCompletedMetadataBatch(t *testing.T) {
	root := storageRenameTestRoot(t)
	if err := os.WriteFile(filepath.Join(root, "ordinary"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	start := time.Unix(1_700_000_000, 0)
	var clock atomic.Int64
	clock.Store(start.UnixMilli())
	originalOpen, originalNow := diskOpenDirectoryForScan, diskScanNow
	release := make(chan struct{})
	diskScanNow = func() time.Time { return time.UnixMilli(clock.Load()) }
	diskOpenDirectoryForScan = func(path string) (diskDirectory, error) {
		dir, err := diskOpenRoot(path)
		if err == nil {
			return diskProgressBatchDirectory{dir, release}, nil
		}
		return dir, err
	}
	defer func() { diskOpenDirectoryForScan, diskScanNow = originalOpen, originalNow }()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	stage := 0
	err := diskScanStream(ctx, &diskControl{skipped: map[string]bool{}, changed: make(chan struct{}, 1)},
		diskScanRequest{Root: root, ScratchDirectory: storageRenameTestRoot(t)}, func(record any) error {
			if _, fact := record.(diskFactRecord); fact && stage == 2 {
				clock.Add((100 * time.Millisecond).Milliseconds())
			}
			progress, ok := record.(diskProgress)
			if !ok {
				return nil
			}
			switch stage {
			case 0:
				if progress.StuckSinceMs != 0 {
					t.Errorf("new directory reported stuck: %#v", progress)
				}
				clock.Store(start.Add(10 * time.Second).UnixMilli())
				stage = 1
			case 1:
				if progress.CurrentPath != root || progress.StuckSinceMs != start.UnixMilli() {
					t.Errorf("missing elapsed stall: %#v", progress)
				}
				close(release)
				stage = 2
			case 2:
				if progress.Items > 1 {
					if progress.StuckSinceMs != 0 {
						t.Errorf("completed metadata failed to clear stall: %#v", progress)
					}
					stage = 3
					cancel()
				}
			}
			return nil
		})
	if err != nil || stage != 3 {
		t.Fatalf("missing stall recovery: stage=%d err=%v", stage, err)
	}
}

func TestDiskScanProgressNamesLongestInactiveDirectory(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	older, newer := filepath.Join(string(filepath.Separator), "z-old"), filepath.Join(string(filepath.Separator), "a-new")
	inFlight := map[string]*diskStreamDirectory{
		older: {lastActivity: now.Add(-11 * time.Second)},
		newer: {lastActivity: now.Add(-time.Second)},
	}
	progress := diskStreamProgress(now, diskSummary{Items: 5, AllocatedBytes: 4096}, inFlight)
	if progress.CurrentPath != diskPathID(older) || progress.StuckSinceMs != now.Add(-11*time.Second).UnixMilli() {
		t.Fatalf("picked lexical path instead of longest inactive directory: %#v", progress)
	}
	delete(inFlight, older)
	if progress := diskStreamProgress(now, diskSummary{}, inFlight); progress.StuckSinceMs != 0 || progress.CurrentPath != diskPathID(newer) {
		t.Fatalf("completed folder left a stale stall: %#v", progress)
	}
	if progress := diskStreamProgress(now, diskSummary{}, nil); progress.CurrentPath != "" || progress.StuckSinceMs != 0 {
		t.Fatalf("empty frontier reported work: %#v", progress)
	}
}

func TestDiskScanProgressDuringLargeMetadataBatch(t *testing.T) {
	root := storageRenameTestRoot(t)
	for index := 0; index < 64; index++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprint(index)), []byte("data"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	start := time.Unix(1_700_000_000, 0)
	var clock atomic.Int64
	clock.Store(start.UnixMilli())
	originalOpen, originalNow := diskOpenDirectoryForScan, diskScanNow
	release := make(chan struct{})
	close(release)
	diskScanNow = func() time.Time { return time.UnixMilli(clock.Load()) }
	diskOpenDirectoryForScan = func(path string) (diskDirectory, error) {
		dir, err := diskOpenRoot(path)
		return diskProgressBatchDirectory{dir, release}, err
	}
	defer func() { diskOpenDirectoryForScan, diskScanNow = originalOpen, originalNow }()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	entries, intermediate := 0, 0
	err := diskScanStream(ctx, &diskControl{skipped: map[string]bool{}, changed: make(chan struct{}, 1)},
		diskScanRequest{Root: root, ScratchDirectory: storageRenameTestRoot(t)}, func(value any) error {
			switch record := value.(type) {
			case diskEntryRecord:
				entries++
				clock.Add((100 * time.Millisecond).Milliseconds())
			case diskProgress:
				if entries > 0 && entries < 64 {
					intermediate++
					if record.StuckSinceMs != 0 || record.CurrentPath != diskPathID(root) || record.Items == 0 {
						t.Errorf("healthy batch progress lost its folder or completed work: %#v", record)
					}
				}
				if entries == 64 {
					cancel()
				}
			}
			return nil
		})
	if err != nil || intermediate == 0 {
		t.Fatalf("no progress during a large completed-metadata batch: entries=%d progress=%d err=%v", entries, intermediate, err)
	}
}

func TestDiskMeasureLargeUnsharedTreeCost(t *testing.T) {
	if os.Getenv("HAPPIER_DISK_MEASURE_QA_COST") == "" || runtime.GOOS != "linux" {
		t.Skip("opt-in Linux helper RSS measurement")
	}
	root := storageRenameTestRoot(t)
	for directory := 0; directory < 100; directory++ {
		path := filepath.Join(root, strconv.Itoa(directory))
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
		for file := 0; file < 500; file++ {
			if err := os.WriteFile(filepath.Join(path, strconv.Itoa(file)), []byte("unshared"), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	request, err := json.Marshal(diskMeasureRequest{Paths: []string{root, filepath.Join(root, "0")}})
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command("/usr/bin/time", "-v", os.Args[0], "-test.run=^TestDiskCommandProcess$")
	child.Env = append(os.Environ(), "HAPPIER_TEST_DISK_COMMAND=disk-measure", "HAPPIER_TEST_DISK_MEASURE_COST=1")
	child.Stdin = bytes.NewReader(request)
	var out, diagnostic bytes.Buffer
	child.Stdout, child.Stderr = &out, &diagnostic
	if err := child.Run(); err != nil {
		t.Fatalf("%v: %s", err, diagnostic.String())
	}
	var measured diskMeasureResult
	if err := json.Unmarshal(out.Bytes(), &measured); err != nil {
		t.Fatal(err)
	}
	if measured.TotalAllocatedBytes == 0 || measured.TotalExclusiveBytes == 0 {
		t.Fatalf("lost singleton allocation: %#v", measured)
	}
	t.Logf("50,000 ordinary files, 101 distinct directories; allocated=%d exclusive=%d\n%s", measured.TotalAllocatedBytes, measured.TotalExclusiveBytes, diagnostic.String())
}

func TestDiskMeasureCatalogRootScale(t *testing.T) {
	root := storageRenameTestRoot(t)
	paths := []string{root}
	for directory := 0; directory < 100; directory++ {
		path := filepath.Join(root, strconv.Itoa(directory))
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
		for file := 0; file < 100; file++ {
			leaf := filepath.Join(path, strconv.Itoa(file))
			if err := os.WriteFile(leaf, []byte("fixture"), 0600); err != nil {
				t.Fatal(err)
			}
			// QA's real catalog has 649 retained log roots alongside data trees.
			if len(paths) <= 650 {
				paths = append(paths, leaf)
			}
		}
	}
	measure := func(paths []string) (diskMeasureResult, time.Duration) {
		started := time.Now()
		result, err := diskMeasure(context.Background(), diskMeasureRequest{Paths: paths})
		if err != nil {
			t.Fatal(err)
		}
		return result, time.Since(started)
	}
	base, single := measure([]string{root})
	result, catalog := measure(paths)
	if result.TotalAllocatedBytes != base.TotalAllocatedBytes || result.TotalExclusiveBytes != base.TotalExclusiveBytes || len(result.PerPath) != len(paths) {
		t.Fatalf("catalog root attribution changed physical union: base=%#v result=%#v", base, result)
	}
	// Adding catalog attribution must not multiply a whole-tree traversal by the
	// number of roots. Relative budget plus a scheduling floor avoids a disk-speed gate.
	budget := 8 * single
	if budget < time.Second {
		budget = time.Second
	}
	t.Logf("same 10,000-file tree: one root=%s, 651 catalog roots=%s", single, catalog)
	if catalog > budget {
		t.Fatalf("catalog membership multiplied tree work: %s > %s", catalog, budget)
	}
}

func TestDiskMeasureSiblingCatalogRootAllocationCost(t *testing.T) {
	root := storageRenameTestRoot(t)
	paths := make([]string, 2048)
	for index := range paths {
		paths[index] = filepath.Join(root, strconv.Itoa(index))
		if err := os.Mkdir(paths[index], 0700); err != nil {
			t.Fatal(err)
		}
	}
	allocations := func(roots []string) float64 {
		return testing.AllocsPerRun(1, func() {
			result, err := diskMeasure(context.Background(), diskMeasureRequest{Paths: roots})
			if err != nil || len(result.PerPath) != len(roots) {
				t.Fatalf("sibling roots lost: roots=%d result=%d err=%v", len(roots), len(result.PerPath), err)
			}
		})
	}
	small, large := allocations(paths[:1024]), allocations(paths)
	t.Logf("1024 sibling roots: %.0f allocations; 2048 sibling roots: %.0f", small, large)
	// Doubling independent roots doubles required metadata and attribution work.
	// Quadratic root-pair comparisons instead approach four times the allocations.
	if large >= 3*small {
		t.Fatalf("catalog root work grows quadratically: %.0f >= 3 * %.0f allocations", large, small)
	}
}

// Keep the real root descriptor and metadata, replacing only OS enumeration so
// the volume-root contract never scans a developer machine's filesystem.
type diskEmptyRootDirectory struct{ diskDirectory }

func (dir diskEmptyRootDirectory) entries(context.Context) ([]diskEntry, string, error) {
	return nil, "fixture-empty-root", nil
}

func TestDiskMeasureFilesystemRootIsNotItsOwnAncestor(t *testing.T) {
	root := filepath.VolumeName(t.TempDir()) + string(filepath.Separator)
	previous := diskOpenDirectoryForScan
	var opened atomic.Int64
	diskOpenDirectoryForScan = func(path string) (diskDirectory, error) {
		if path != root {
			return nil, fmt.Errorf("unexpected enumeration outside fixture: %s", path)
		}
		opened.Add(1)
		directory, err := diskOpenRoot(path)
		if err != nil {
			return nil, err
		}
		return diskEmptyRootDirectory{directory}, nil
	}
	defer func() { diskOpenDirectoryForScan = previous }()
	result, err := diskMeasure(context.Background(), diskMeasureRequest{Paths: []string{root}})
	if err != nil || len(result.PerPath) != 1 || result.PerPath[0].Items != 1 || opened.Load() != 1 {
		t.Fatalf("filesystem root must be measured once: result=%+v opened=%d err=%v", result, opened.Load(), err)
	}
}

func TestDiskMeasureRootAliasesRetainNestedIdentityPaths(t *testing.T) {
	root := t.TempDir()
	canonical, alias := filepath.Join(root, "a"), filepath.Join(root, "b")
	nested, selected := filepath.Join(alias, "nested"), filepath.Join(alias, "nested", "selected")
	firstLink, secondLink := filepath.Join(root, "link-a"), filepath.Join(root, "link-b")
	// Native metadata facts model two directory spellings with the same identity
	// (a bind mount or case alias), plus genuine distinct hard-link file names.
	facts := map[string]diskMetadata{
		canonical:  {identity: "directory", device: "device", kind: "folder"},
		alias:      {identity: "directory", device: "device", kind: "folder"},
		nested:     {identity: "nested", device: "device", kind: "folder"},
		selected:   {identity: "selected", device: "device", kind: "file", nlink: 1},
		firstLink:  {identity: "hardlink", device: "device", kind: "file", nlink: 2},
		secondLink: {identity: "hardlink", device: "device", kind: "file", nlink: 2},
	}
	roots := diskMeasureRoots([]string{canonical, alias, nested, selected, firstLink, secondLink})
	aliases := diskMeasureRootAliases(roots, facts)
	for path, expected := range map[string]string{
		canonical: canonical, alias: canonical,
		nested: filepath.Join(canonical, "nested"), selected: filepath.Join(canonical, "nested", "selected"),
		firstLink: firstLink, secondLink: secondLink,
	} {
		if aliases[path] != expected {
			t.Fatalf("root %s resolved to %s, expected %s", path, aliases[path], expected)
		}
	}
}

type diskBlockingDirectory struct{ diskDirectory }

func (dir diskBlockingDirectory) entries(context.Context) ([]diskEntry, string, error) {
	// Real OS pipe read: like a stalled filesystem syscall it ignores Go context.
	reader, writer, err := os.Pipe()
	if err != nil {
		return nil, "fixture", err
	}
	defer reader.Close()
	defer writer.Close()
	_, err = reader.Read(make([]byte, 1))
	return nil, "fixture", err
}

func TestDiskScanOwnerCancelRetiresBlockedHelper(t *testing.T) {
	root := storageRenameTestRoot(t)
	blocked := filepath.Join(root, "blocked")
	if err := os.Mkdir(blocked, 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestDiskCommandProcess$")
	child.Env = append(os.Environ(), "HAPPIER_TEST_DISK_COMMAND=disk-scan", "HAPPIER_TEST_DISK_BLOCK="+blocked)
	input, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = input.Close(); _ = child.Process.Kill() }()
	if err := json.NewEncoder(input).Encode(diskScanRequest{Root: root, ScratchDirectory: storageRenameTestRoot(t)}); err != nil {
		t.Fatal(err)
	}
	var killedAt time.Time
	scanner := bufio.NewScanner(output)
	for scanner.Scan() {
		var record diskProgress
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			t.Fatal(err)
		}
		if record.Type == "progress" && record.CurrentPath == diskPathID(blocked) {
			killedAt = time.Now()
			if err := child.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			break
		}
	}
	err = child.Wait()
	if killedAt.IsZero() || err == nil || ctx.Err() != nil {
		t.Fatalf("blocked helper failed to retire through process termination: requested=%v err=%v context=%v", !killedAt.IsZero(), err, ctx.Err())
	}
	t.Logf("blocked helper cancel-to-exit: %s", time.Since(killedAt))
}

func TestDiskScanOwnerBlockedSkipRetiresHelper(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	finished, blocked, pending := filepath.Join(root, "a-finished"), filepath.Join(root, "b-blocked"), filepath.Join(root, "c-pending")
	if runtime.GOOS == "linux" {
		blocked += string([]byte{0xff})
	}
	for _, path := range []string{finished, blocked, pending, filepath.Join(pending, "nested")} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(finished, "data"), bytes.Repeat([]byte("x"), 8192), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(finished, "data"), filepath.Join(pending, "nested", "shared")); err != nil {
		t.Skipf("hardlink fixture unavailable: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestDiskCommandProcess$")
	child.Env = append(os.Environ(), "HAPPIER_TEST_DISK_COMMAND=disk-scan", "HAPPIER_TEST_DISK_BLOCK="+blocked, "HAPPIER_TEST_DISK_PENDING_BLOCK="+filepath.Join(pending, "nested"))
	input, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var diagnostic bytes.Buffer
	child.Stderr = &diagnostic
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	encoder := json.NewEncoder(input)
	// Two workers intentionally block. Start the selected Skip target first so
	// the longest-inactive report identifies it independent of worker timing.
	if err := encoder.Encode(diskScanRequest{Root: root, ScratchDirectory: storageRenameTestRoot(t), PriorityHints: []string{blocked}}); err != nil {
		t.Fatal(err)
	}
	var summary map[string]json.RawMessage
	completed := map[string]diskDirRecord{}
	observations := map[string]map[string]any{}
	sentSkip := false
	streamedFrontier := []string{}
	scanner := bufio.NewScanner(output)
	for scanner.Scan() {
		var record struct {
			Type, ID, CurrentPath, Path string
			Complete                    bool
		}
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			t.Fatal(err)
		}
		if record.Type == "progress" && record.CurrentPath == diskPathID(blocked) && !sentSkip && completed[finished].AllocatedBytes >= 8192 {
			sentSkip = true
			if err := encoder.Encode(map[string]string{"type": "skip", "path": diskPathID(blocked)}); err != nil {
				t.Fatal(err)
			}
		}
		if record.Type == "dir" && record.Complete {
			var dir diskDirRecord
			if err := json.Unmarshal(scanner.Bytes(), &dir); err != nil {
				t.Fatal(err)
			}
			completed[record.ID] = dir
		}
		if record.Type == "dir" {
			var dir struct {
				AllocationFacts []map[string]any
				Children, Files []struct{ AllocationFacts []map[string]any }
			}
			if err := json.Unmarshal(scanner.Bytes(), &dir); err != nil {
				t.Fatal(err)
			}
			facts := dir.AllocationFacts
			for _, node := range append(dir.Children, dir.Files...) {
				facts = append(facts, node.AllocationFacts...)
			}
			for _, fact := range facts {
				key, _ := fact["key"].(string)
				if _, known := observations[key]; !known {
					observations[key] = fact
				}
			}
		}
		if record.Type == "fact" {
			var item struct{ Fact map[string]any }
			if err := json.Unmarshal(scanner.Bytes(), &item); err != nil {
				t.Fatal(err)
			}
			key, _ := item.Fact["key"].(string)
			if _, known := observations[key]; !known {
				observations[key] = item.Fact
			}
		}
		if record.Type == "summary" {
			if err := json.Unmarshal(scanner.Bytes(), &summary); err != nil {
				t.Fatal(err)
			}
		}
		if record.Type == "frontier-item" {
			streamedFrontier = append(streamedFrontier, record.Path)
		}
	}
	_ = input.Close()
	err = child.Wait()
	if err != nil || !sentSkip {
		t.Fatalf("blocked helper did not retire after skip: %v, skipped=%v, stderr=%s", err, sentSkip, diagnostic.String())
	}
	var termination string
	var frontier []string
	var skipped []diskIssue
	json.Unmarshal(summary["termination"], &termination)
	json.Unmarshal(summary["pendingFrontier"], &frontier)
	var frontierStream bool
	json.Unmarshal(summary["streamedFrontier"], &frontierStream)
	if frontierStream {
		frontier = streamedFrontier
	}
	json.Unmarshal(summary["skipped"], &skipped)
	if termination != "interrupted" || len(frontier) == 0 || len(skipped) != 1 || skipped[0].Path != diskPathID(blocked) || completed[finished].AllocatedBytes < 8192 {
		t.Fatalf("retirement lost finished work or pending recovery facts: summary=%s finished=%#v", summary, completed)
	}
	for _, path := range frontier {
		if path == diskPathID(blocked) || path == finished || path == root {
			t.Fatalf("recovery would revisit skipped/finished subtree: %v", frontier)
		}
	}
	var projection bytes.Buffer
	for _, fact := range observations {
		if err := json.NewEncoder(&projection).Encode(map[string]any{"v": 1, "type": "prior-observation", "id": fact["pathId"], "key": fact["key"], "allocatedBytes": fact["allocatedBytes"]}); err != nil {
			t.Fatal(err)
		}
	}
	priorPath := filepath.Join(t.TempDir(), "same-scan.ndjson")
	if err := os.WriteFile(priorPath, projection.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	resumed := runDiskOwner(t, "disk-scan", diskScanRequest{Root: root, ResumeFrom: frontier, PreviousIndexPath: priorPath})
	resumedDirs := map[string]bool{}
	for _, line := range bytes.Split(bytes.TrimSpace(resumed), []byte{'\n'}) {
		var item diskDirRecord
		if err := json.Unmarshal(line, &item); err != nil {
			t.Fatal(err)
		}
		if item.Type == "dir" {
			resumedDirs[item.ID] = true
		}
	}
	if resumedDirs[diskPathID(blocked)] || !resumedDirs[diskPathID(filepath.Join(pending, "nested"))] {
		t.Fatalf("recovery revisited blocked subtree or lost unrelated work: %s", resumed)
	}
	var beforeBytes int64
	json.Unmarshal(summary["allocatedBytes"], &beforeBytes)
	var resumedSummary diskSummary
	for _, line := range bytes.Split(bytes.TrimSpace(resumed), []byte{'\n'}) {
		var item diskSummary
		if err := json.Unmarshal(line, &item); err != nil {
			t.Fatal(err)
		}
		if item.Type == "summary" {
			resumedSummary = item
		}
	}
	var expected diskMeasureResult
	if err := json.Unmarshal(runDiskOwner(t, "disk-measure", diskMeasureRequest{Paths: []string{root}}), &expected); err != nil {
		t.Fatal(err)
	}
	if beforeBytes+resumedSummary.AllocatedBytes != expected.TotalAllocatedBytes {
		t.Fatalf("resume double-counted cross-frontier hardlink/directory observations: before=%d resumed=%d union=%d", beforeBytes, resumedSummary.AllocatedBytes, expected.TotalAllocatedBytes)
	}
}

func runDiskOwner(t *testing.T, command string, request any) []byte {
	output := runDiskOwnerRaw(t, command, request)
	if command == "disk-scan" {
		return diskCollectScanFixture(t, output)
	}
	return output
}
func runDiskOwnerRaw(t *testing.T, command string, request any) []byte {
	t.Helper()
	if scan, ok := request.(diskScanRequest); ok {
		scan.ScratchDirectory = storageRenameTestRoot(t)
		request = scan
	}
	if command == "disk-scan" {
		if fields, ok := request.(map[string]any); ok {
			copy := map[string]any{}
			for key, value := range fields {
				copy[key] = value
			}
			copy["scratchDirectory"] = storageRenameTestRoot(t)
			request = copy
		}
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestDiskCommandProcess$")
	child.Env = append(os.Environ(), "HAPPIER_TEST_DISK_COMMAND="+command)
	child.Stdin = bytes.NewReader(append(encoded, '\n'))
	var stderr bytes.Buffer
	child.Stderr = &stderr
	output, err := child.Output()
	if err != nil {
		t.Fatalf("%s owner failed: %v; stderr: %s", command, err, stderr.String())
	}
	return output
}

func TestDiskScanDeveloperSummaryRetainsOrdinaryFiles(t *testing.T) {
	root := storageRenameTestRoot(t)
	verified := filepath.Join(root, "project", "node_modules")
	unverified := filepath.Join(root, "source", "node_modules")
	for _, path := range []string{verified, unverified} {
		if err := os.MkdirAll(filepath.Join(path, "nested"), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, "nested", "ordinary"), bytes.Repeat([]byte("x"), 8192), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "project", "package.json"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	request := map[string]any{"root": root, "keepMinBytes": 0, "atomicRules": []any{map[string]any{"names": []string{"node_modules"}, "manifests": []string{"package.json"}}}}
	output := runDiskOwnerRaw(t, "disk-scan", request)
	directories := map[string]bool{}
	files := map[string]bool{}
	summarized := false
	for _, line := range bytes.Split(bytes.TrimSpace(output), []byte{'\n'}) {
		var record struct {
			Type, ID   string
			Summarized bool
			Node       diskNode
		}
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatal(err)
		}
		if record.Type == "dir" {
			directories[record.ID] = true
			if record.ID == verified {
				summarized = record.Summarized
			}
		}
		if record.Type == "dir-entry" && record.Node.Kind == "file" {
			files[record.Node.ID] = true
		}
	}
	if !summarized || directories[filepath.Join(verified, "nested")] || !directories[filepath.Join(unverified, "nested")] {
		t.Fatalf("manifest-backed summary boundary wrong: summarized=%v dirs=%#v", summarized, directories)
	}
	for _, path := range []string{verified, unverified} {
		if !files[filepath.Join(path, "nested", "ordinary")] {
			t.Fatalf("ordinary file query fact lost under %s", path)
		}
	}
}

// Owner tests inspect the real subprocess stream. This small fixture collector
// reconstructs convenient assertions, not the production scanner or reducer;
// the memory regression deliberately discards every record instead.
func diskCollectScanFixture(t *testing.T, stream []byte) []byte {
	t.Helper()
	children := map[string]map[string]diskEntryRecord{}
	facts := map[string]map[string]diskAllocationFact{}
	published := map[string]bool{}
	relists := map[string]bool{}
	frontier := []string{}
	var output bytes.Buffer
	write := func(record any) {
		if err := json.NewEncoder(&output).Encode(record); err != nil {
			t.Fatal(err)
		}
	}
	for _, line := range bytes.Split(bytes.TrimSpace(stream), []byte{'\n'}) {
		var tag struct{ Type string }
		if err := json.Unmarshal(line, &tag); err != nil {
			t.Fatal(err)
		}
		switch tag.Type {
		case "dir-start":
			var record diskDirRecord
			json.Unmarshal(line, &record)
			var mode struct{ RelistOnly bool }
			json.Unmarshal(line, &mode)
			relists[record.ID] = mode.RelistOnly
			children[record.ID] = map[string]diskEntryRecord{}
			facts[record.ID] = map[string]diskAllocationFact{}
		case "dir-entry":
			var record diskEntryRecord
			json.Unmarshal(line, &record)
			if children[record.Parent] == nil {
				children[record.Parent] = map[string]diskEntryRecord{}
			}
			children[record.Parent][record.Node.ID] = record
			if record.ReplaceFacts {
				facts[record.Node.ID] = map[string]diskAllocationFact{}
			}
		case "fact":
			var record diskFactRecord
			json.Unmarshal(line, &record)
			if facts[record.Owner] == nil {
				facts[record.Owner] = map[string]diskAllocationFact{}
			}
			key := record.Fact.Key + "\x00" + record.Fact.PathID
			facts[record.Owner][key] = record.Fact
		case "dir":
			var record diskDirRecord
			json.Unmarshal(line, &record)
			record.RelistOnly = relists[record.ID]
			all := []diskNode{}
			record.Children = []diskNode{}
			record.Files = []diskNode{}
			ids := []string{}
			record.RetainedSubtrees = nil
			for id, entry := range children[record.ID] {
				node := entry.Node
				node.AllocationFacts = nil
				for _, fact := range facts[id] {
					node.AllocationFacts = append(node.AllocationFacts, fact)
				}
				all = append(all, node)
				ids = append(ids, id)
				if entry.Visible {
					record.Children = append(record.Children, node)
				}
				if node.Kind == "file" {
					record.Files = append(record.Files, node)
				}
				if entry.Retained {
					record.RetainedSubtrees = append(record.RetainedSubtrees, id)
				}
			}
			if record.RelistOnly {
				record.DirectChildIDs = &ids
			}
			for _, fact := range facts[record.ID] {
				record.AllocationFacts = append(record.AllocationFacts, fact)
			}
			if !published[record.ID] {
				initial := record
				initial.Children = all
				initial.Complete = false
				write(initial)
				published[record.ID] = true
			}
			write(record)
		case "frontier-start":
			frontier = []string{}
		case "frontier-item":
			var record struct{ Path string }
			json.Unmarshal(line, &record)
			frontier = append(frontier, record.Path)
		case "summary":
			var record diskSummary
			json.Unmarshal(line, &record)
			if record.StreamedFrontier {
				record.PendingFrontier = frontier
				record.StreamedFrontier = false
			}
			write(record)
		default:
			output.Write(line)
			output.WriteByte('\n')
		}
	}
	return output.Bytes()
}

func TestDiskOwnerExactBytePaths(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("NTFS paths use Unicode rather than raw POSIX bytes")
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	raw, twin := filepath.Join(root, string([]byte{0xff})), filepath.Join(root, "�")
	if err := os.Mkdir(raw, 0700); err != nil {
		t.Skipf("filesystem does not accept byte path: %v", err)
	}
	if err := os.Mkdir(twin, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(raw, "leaf"), bytes.Repeat([]byte("a"), 8192), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(twin, "leaf"), bytes.Repeat([]byte("b"), 65536), 0600); err != nil {
		t.Fatal(err)
	}
	var measured diskMeasureResult
	if err := json.Unmarshal(runDiskOwner(t, "disk-measure", diskMeasureRequest{Paths: []string{diskPathID(raw)}}), &measured); err != nil {
		t.Fatal(err)
	}
	if len(measured.PerPath) != 1 || measured.PerPath[0].Path != diskPathID(raw) || measured.TotalAllocatedBytes < 8192 || measured.TotalAllocatedBytes >= 65536 {
		t.Fatalf("byte measurement selected replacement twin: %#v", measured)
	}
	scan := runDiskOwner(t, "disk-scan", diskScanRequest{Root: diskPathID(raw)})
	if !bytes.Contains(scan, []byte(diskPathID(raw))) || bytes.Contains(scan, []byte(twin)) {
		t.Fatalf("byte scan selected replacement twin: %s", scan)
	}
}

func TestDiskMeasureOwnerSubtreeLastChangedAt(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	first, second := filepath.Join(root, "a"), filepath.Join(root, "b")
	for _, path := range []string{first, second} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	leaf := filepath.Join(first, "leaf")
	if err := os.WriteFile(leaf, bytes.Repeat([]byte("a"), 8192), 0600); err != nil {
		t.Fatal(err)
	}
	linked := filepath.Join(second, "linked")
	if err := os.Link(leaf, linked); err != nil {
		t.Skipf("hardlink fixture unavailable: %v", err)
	}
	oldDay, newDay := time.Date(2026, 1, 2, 12, 0, 0, 0, time.UTC), time.Date(2026, 1, 3, 12, 0, 0, 0, time.UTC)
	for _, path := range []string{first, second, leaf, linked} {
		if err := os.Chtimes(path, oldDay, oldDay); err != nil {
			t.Fatal(err)
		}
	}
	type measuredPath struct {
		Path            string `json:"path"`
		AllocatedBytes  int64  `json:"allocatedBytes"`
		LastChangedAtMs *int64 `json:"lastChangedAtMs,omitempty"`
	}
	measure := func() map[string]measuredPath {
		var result struct {
			PerPath []measuredPath `json:"perPath"`
		}
		if err := json.Unmarshal(runDiskOwner(t, "disk-measure", map[string]any{"paths": []string{second, first}}), &result); err != nil {
			t.Fatal(err)
		}
		byPath := map[string]measuredPath{}
		for _, path := range result.PerPath {
			byPath[path.Path] = path
		}
		return byPath
	}
	before := measure()
	if err := os.WriteFile(leaf, bytes.Repeat([]byte("b"), 8192), 0600); err != nil {
		t.Fatal(err)
	}
	// NTFS may retain each hardlink's directory-entry timestamp until that
	// name is opened. Update both names so each observed subtree sees the edit.
	for _, path := range []string{leaf, linked} {
		if err := os.Chtimes(path, newDay, newDay); err != nil {
			t.Fatal(err)
		}
	}
	after := measure()
	for _, path := range []string{first, second} {
		if before[path].LastChangedAtMs == nil || *before[path].LastChangedAtMs != oldDay.UnixMilli() {
			t.Fatalf("missing original subtree timestamp: %#v", before[path])
		}
		if after[path].LastChangedAtMs == nil || *after[path].LastChangedAtMs != newDay.UnixMilli() {
			t.Fatalf("same-allocation leaf change hidden from selected root: %#v", after[path])
		}
		if before[path].AllocatedBytes != after[path].AllocatedBytes {
			t.Fatalf("fixture allocation changed: before=%#v after=%#v", before[path], after[path])
		}
		info, err := os.Stat(path)
		if err != nil || info.ModTime().UnixMilli() != oldDay.UnixMilli() {
			t.Fatalf("fixture parent timestamp changed: %v %v", info, err)
		}
	}
}

func TestDiskMeasureOwnerUnknownLastChangedAt(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	leaf := filepath.Join(root, "epoch-file")
	if err := os.WriteFile(leaf, []byte("epoch"), 0600); err != nil {
		t.Fatal(err)
	}
	epoch := time.UnixMilli(0)
	if err := os.Chtimes(leaf, epoch, epoch); err != nil {
		t.Fatal(err)
	}
	var result struct {
		PerPath []map[string]json.RawMessage `json:"perPath"`
	}
	if err := json.Unmarshal(runDiskOwner(t, "disk-measure", map[string]any{"paths": []string{leaf}}), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.PerPath) != 1 {
		t.Fatalf("missing measurement: %#v", result)
	}
	if _, present := result.PerPath[0]["lastChangedAtMs"]; present {
		t.Fatalf("epoch timestamp is unknown, not a credible change day: %#v", result)
	}
	positive := time.UnixMilli(1)
	if err := os.Chtimes(leaf, positive, positive); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(runDiskOwner(t, "disk-measure", map[string]any{"paths": []string{leaf}}), &result); err != nil {
		t.Fatal(err)
	}
	if changed := result.PerPath[0]["lastChangedAtMs"]; string(changed) != "1" {
		t.Fatalf("positive timestamp must not be hidden by an arbitrary epoch cutoff: %s", changed)
	}
}

func TestDiskMeasureOwnerHardlinksAcrossRoots(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	first, second := filepath.Join(root, "a"), filepath.Join(root, "b")
	for _, path := range []string{first, second} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	original := filepath.Join(first, "data")
	if err := os.WriteFile(original, bytes.Repeat([]byte("x"), 8192), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(original, filepath.Join(second, "linked")); err != nil {
		t.Skipf("hardlinks unavailable: %v", err)
	}
	type size struct {
		Path           string
		AllocatedBytes int64
		ExclusiveBytes int64
		SharedBytes    int64
		Items          int64
		AtLeast        bool
	}
	var result struct {
		PerPath             []size
		TotalAllocatedBytes int64
		TotalExclusiveBytes int64
	}
	if err := json.Unmarshal(runDiskOwner(t, "disk-measure", map[string]any{"paths": []string{second, first}}), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.PerPath) != 2 {
		t.Fatalf("missing per-path sizes: %#v", result)
	}
	byPath := map[string]size{}
	for _, item := range result.PerPath {
		byPath[item.Path] = item
	}
	if byPath[first].AllocatedBytes <= byPath[second].AllocatedBytes {
		t.Fatalf("hardlink winner must be lexical root: %#v", result)
	}
	if byPath[first].SharedBytes < 8192 || byPath[first].ExclusiveBytes >= byPath[first].AllocatedBytes {
		t.Fatalf("external link must not be reclaimable per root: %#v", result)
	}
	if result.TotalExclusiveBytes != result.TotalAllocatedBytes {
		t.Fatalf("union contains all links and must reclaim allocation: %#v", result)
	}
	if byPath[first].AtLeast || byPath[second].AtLeast {
		t.Fatalf("readable fixture reported incomplete: %#v", result)
	}
}

func TestDiskMeasureOwnerNestedRootsAttributeMostSpecific(t *testing.T) {
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cache := filepath.Join(home, "cache")
	nested := filepath.Join(cache, "nested")
	if err := os.MkdirAll(nested, 0700); err != nil {
		t.Fatal(err)
	}
	paths := []string{home, cache, nested}
	expected := map[string]int64{}
	fileAllocation := map[string]int64{}
	for _, path := range paths {
		file := filepath.Join(path, "ordinary")
		if err := os.WriteFile(file, bytes.Repeat([]byte("x"), 8192), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range paths {
		dir, err := diskReadMetadata(path)
		if err != nil {
			t.Fatal(err)
		}
		file, err := diskReadMetadata(filepath.Join(path, "ordinary"))
		if err != nil {
			t.Fatal(err)
		}
		if file.allocatedBytes <= 0 {
			t.Fatalf("fixture has no allocated file bytes: %#v", file)
		}
		expected[path] = dir.allocatedBytes + file.allocatedBytes
		fileAllocation[path] = file.allocatedBytes
	}
	var result diskMeasureResult
	if err := json.Unmarshal(runDiskOwner(t, "disk-measure", diskMeasureRequest{Paths: []string{nested, home, cache}}), &result); err != nil {
		t.Fatal(err)
	}
	var total int64
	for _, size := range result.PerPath {
		if size.AllocatedBytes != expected[size.Path] || size.ExclusiveBytes != expected[size.Path] || size.AtLeast {
			t.Fatalf("nested allocation must belong to its most-specific requested root: size=%#v expected=%d result=%#v", size, expected[size.Path], result)
		}
		total += expected[size.Path]
	}
	if len(result.PerPath) != len(paths) || result.TotalAllocatedBytes != total || result.TotalExclusiveBytes != total {
		t.Fatalf("nested-root attribution changed union accounting: %#v expected=%d", result, total)
	}
	if err := os.Link(filepath.Join(nested, "ordinary"), filepath.Join(home, "shared-alias")); err != nil {
		t.Fatal(err)
	}
	homeMetadata, err := diskReadMetadata(home)
	if err != nil {
		t.Fatal(err)
	}
	total += homeMetadata.allocatedBytes + fileAllocation[home] - expected[home]
	expected[home] = homeMetadata.allocatedBytes + fileAllocation[home]
	if err := json.Unmarshal(runDiskOwner(t, "disk-measure", diskMeasureRequest{Paths: paths}), &result); err != nil {
		t.Fatal(err)
	}
	for _, size := range result.PerPath {
		exclusive := expected[size.Path]
		if size.Path == nested {
			exclusive -= fileAllocation[nested]
		}
		if size.AllocatedBytes != expected[size.Path] || size.ExclusiveBytes != exclusive || size.AtLeast {
			t.Fatalf("most-specific winner cannot use its ancestor's hardlink proof: size=%#v expectedAllocation=%d expectedExclusive=%d", size, expected[size.Path], exclusive)
		}
	}
	if result.TotalAllocatedBytes != total || result.TotalExclusiveBytes != total {
		t.Fatalf("ancestor alias must remain reclaimable only by the selected union: %#v expected=%d", result, total)
	}
}

func TestDiskScanOwnerSymlinkLoopAndSparseFile(t *testing.T) {
	root := storageRenameTestRoot(t)
	sparse := filepath.Join(root, "sparse")
	file, err := os.Create(sparse)
	if err != nil {
		t.Fatal(err)
	}
	if err = file.Truncate(16 * 1024 * 1024); err != nil {
		t.Fatal(err)
	}
	if err = file.Close(); err != nil {
		t.Fatal(err)
	}
	symlinkSupported := os.Symlink(root, filepath.Join(root, "loop")) == nil
	output := runDiskOwner(t, "disk-scan", map[string]any{"root": root, "keepMinBytes": 0})
	var summaryFound, sparseFound, loopFound bool
	for _, line := range bytes.Split(bytes.TrimSpace(output), []byte{'\n'}) {
		var record map[string]any
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatal(err)
		}
		if record["type"] == "summary" {
			summaryFound = true
			if record["termination"] != "completed" {
				t.Fatalf("scan incomplete: %s", line)
			}
		}
		if record["type"] != "dir" {
			continue
		}
		children, _ := record["children"].([]any)
		for _, raw := range children {
			node := raw.(map[string]any)
			if node["name"] == "sparse" {
				sparseFound = true
				if node["logicalBytes"] != float64(16*1024*1024) {
					t.Fatalf("logical bytes lost: %#v", node)
				}
			}
			if node["name"] == "loop" {
				loopFound = true
				if node["kind"] != "symlink" {
					t.Fatalf("symlink followed: %#v", node)
				}
			}
		}
	}
	if !summaryFound || !sparseFound || (symlinkSupported && !loopFound) {
		t.Fatalf("missing completed scan fixture records: %s", output)
	}
}

func TestDiskScanOwnerResumeFrontier(t *testing.T) {
	root := storageRenameTestRoot(t)
	finished := filepath.Join(root, "finished")
	pending := filepath.Join(root, "pending")
	nested := filepath.Join(pending, "nested")
	for _, path := range []string{finished, pending, nested} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{filepath.Join(finished, "old"), filepath.Join(nested, "new")} {
		if err := os.WriteFile(path, bytes.Repeat([]byte("x"), 8192), 0600); err != nil {
			t.Fatal(err)
		}
	}
	output := runDiskOwner(t, "disk-scan", map[string]any{"root": root, "keepMinBytes": 0, "resumeFrom": []string{nested, pending, pending}})
	completedIDs := map[string]bool{}
	foundPending := false
	var summary diskSummary
	for _, line := range bytes.Split(bytes.TrimSpace(output), []byte{'\n'}) {
		var record diskDirRecord
		json.Unmarshal(line, &record)
		if record.Type == "summary" {
			json.Unmarshal(line, &summary)
		}
		if record.Type != "dir" {
			continue
		}
		if record.ID == root || record.ID == finished {
			t.Fatalf("resume rescanned a completed subtree: %s", line)
		}
		if record.Complete && record.ID == nested {
			completedIDs[record.ID] = true
		}
		if record.Complete && record.ID == pending {
			foundPending = true
			if record.Parent != root {
				t.Fatalf("frontier lost parent: %#v", record)
			}
		}
	}
	var measure diskMeasureResult
	if err := json.Unmarshal(runDiskOwner(t, "disk-measure", map[string]any{"paths": []string{pending}}), &measure); err != nil {
		t.Fatal(err)
	}
	if len(completedIDs) != 1 || !foundPending || summary.AllocatedBytes != measure.TotalAllocatedBytes {
		t.Fatalf("frontier duplicates or incorrect invocation size: %s; measure %#v", output, measure)
	}
}

func TestDiskScanRejectsMissingIndexAndOutsideFrontier(t *testing.T) {
	root := t.TempDir()
	for _, request := range []map[string]any{{"root": root, "previousIndexPath": filepath.Join(root, "index.sqlite")}, {"root": root, "resumeFrom": []string{filepath.Dir(root)}}, {"root": root, "skippedPaths": []string{root}}, {"root": root, "resumeFrom": []string{root}, "skippedPaths": []string{filepath.Dir(root)}}} {
		encoded, _ := json.Marshal(request)
		var output bytes.Buffer
		if err := diskScanCommand(nil, bytes.NewReader(append(encoded, '\n')), &output); err == nil {
			t.Fatalf("unsafe or unsupported resume request was accepted: %#v", request)
		}
	}
}

func TestDiskScanPreviousIndexInput(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	leaf := filepath.Join(root, "changed")
	if err := os.WriteFile(leaf, bytes.Repeat([]byte("x"), 8192), 0600); err != nil {
		t.Fatal(err)
	}
	index := filepath.Join(t.TempDir(), "prior.ndjson")
	row, _ := json.Marshal(map[string]any{"v": 1, "type": "prior-dir", "id": root, "allocatedBytes": 1})
	if err := os.WriteFile(index, append(row, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	output := runDiskOwner(t, "disk-scan", diskScanRequest{Root: root, PreviousIndexPath: index, KeepMinBytes: 1 << 30})
	var found bool
	var permissionFound bool
	for _, line := range bytes.Split(bytes.TrimSpace(output), []byte{'\n'}) {
		var record diskDirRecord
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatal(err)
		}
		if record.Type == "dir" && record.Complete && record.ID == root {
			found = len(record.Files) == 1 && record.Files[0].ID == leaf && record.AllocatedBytes > 1
			var metadata struct {
				OwnLogicalBytes *int64
				Files           []struct {
					AllocationFacts []struct {
						MtimeMs     *int64
						AgeIncluded *bool
					}
				}
			}
			if err := json.Unmarshal(line, &metadata); err != nil {
				t.Fatal(err)
			}
			own, err := diskReadMetadata(root)
			if err != nil {
				t.Fatal(err)
			}
			if metadata.OwnLogicalBytes == nil || *metadata.OwnLogicalBytes != own.logicalBytes || len(metadata.Files) != 1 || len(metadata.Files[0].AllocationFacts) == 0 || metadata.Files[0].AllocationFacts[0].MtimeMs == nil || *metadata.Files[0].AllocationFacts[0].MtimeMs <= 0 || metadata.Files[0].AllocationFacts[0].AgeIncluded == nil || !*metadata.Files[0].AllocationFacts[0].AgeIncluded {
				t.Fatalf("stream lacks own logical size/component age metadata for resumed rollup: %s", line)
			}
		}
		if record.Type == "permission" {
			var fact struct {
				FullDiskAccess struct {
					State             string
					Binary            struct{ Name, Path string }
					WaitingForConsent bool
				}
			}
			if err := json.Unmarshal(line, &fact); err != nil {
				t.Fatal(err)
			}
			permissionFound = fact.FullDiskAccess.State != "" && fact.FullDiskAccess.Binary.Name != "" && filepath.IsAbs(fact.FullDiskAccess.Binary.Path) && !fact.FullDiskAccess.WaitingForConsent
		}
	}
	if !found {
		t.Fatalf("prior index must guide a fresh scan, never substitute old sizes: %s", output)
	}
	if !permissionFound {
		t.Fatalf("scan lacks named-helper permission facts: %s", output)
	}
}

func TestDiskScanOwnerProjectedFrontier(t *testing.T) {
	root := storageRenameTestRoot(t)
	finished, pending := filepath.Join(root, "finished"), filepath.Join(root, "pending")
	for _, path := range []string{finished, filepath.Join(pending, "nested")} {
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(pending, "nested", "leaf"), bytes.Repeat([]byte("x"), 8192), 0600); err != nil {
		t.Fatal(err)
	}
	prior := filepath.Join(storageRenameTestRoot(t), "projection.ndjson")
	var rows bytes.Buffer
	for _, path := range []string{filepath.Join(pending, "nested"), pending, pending} {
		if err := json.NewEncoder(&rows).Encode(map[string]any{"v": 1, "type": "prior-frontier", "id": diskPathID(path)}); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(prior, rows.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	for _, resume := range []bool{true, false} {
		request := map[string]any{"root": root, "previousIndexPath": prior}
		if resume {
			request["resumeFrom"] = []string{}
		}
		output := runDiskOwner(t, "disk-scan", request)
		seen := map[string]bool{}
		for _, line := range bytes.Split(bytes.TrimSpace(output), []byte{'\n'}) {
			var dir diskDirRecord
			if err := json.Unmarshal(line, &dir); err != nil {
				t.Fatal(err)
			}
			if dir.Type == "dir" {
				seen[dir.ID] = true
			}
		}
		if !seen[filepath.Join(pending, "nested")] || (resume && (seen[root] || seen[finished])) || (!resume && (!seen[root] || !seen[finished])) {
			t.Fatalf("projected frontier/fresh distinction lost: resume=%v dirs=%v", resume, seen)
		}
	}
}

func TestDiskScanOwnerRelistsOnlyDirectEntries(t *testing.T) {
	root := storageRenameTestRoot(t)
	child := filepath.Join(root, "indexed")
	if runtime.GOOS == "linux" {
		child += string([]byte{0xff})
	} else if runtime.GOOS == "darwin" {
		child = filepath.Join(root, "Product.app")
	}
	if err := os.MkdirAll(filepath.Join(child, "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	direct := filepath.Join(root, "direct")
	for path, size := range map[string]int{direct: 8192, filepath.Join(child, "nested", "data"): 32768} {
		if err := os.WriteFile(path, bytes.Repeat([]byte("x"), size), 0600); err != nil {
			t.Fatal(err)
		}
	}
	var oldChild diskNode
	var oldGroups diskAgeGroups
	for _, line := range bytes.Split(bytes.TrimSpace(runDiskOwner(t, "disk-scan", diskScanRequest{Root: root})), []byte{'\n'}) {
		var record diskDirRecord
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatal(err)
		}
		if record.Type == "dir" && record.ID == root {
			for _, node := range record.Children {
				if node.ID == diskPathID(child) {
					oldChild = node
				}
			}
		}
		if record.Type == "dir" && record.ID == diskPathID(child) {
			oldGroups = record.AgeGroupBytes
		}
	}
	if oldChild.AllocatedBytes < 32768 {
		t.Fatalf("completed child fixture lacks prior aggregate: %#v", oldChild)
	}
	childMeta, err := diskReadMetadata(child)
	if err != nil {
		t.Fatal(err)
	}
	prior := filepath.Join(t.TempDir(), "relist.ndjson")
	row, err := json.Marshal(map[string]any{"v": 1, "type": "prior-child", "id": diskPathID(child),
		"allocatedBytes": oldChild.AllocatedBytes, "logicalBytes": oldChild.LogicalBytes, "items": oldChild.Items,
		"identityKey": diskAllocationKey(child, childMeta), "flags": oldChild.Flags, "ageGroupBytes": oldGroups})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(prior, append(row, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	// This unindexed child must remain honest lower-bound metadata, not be walked.
	unknown := filepath.Join(root, "unindexed")
	if runtime.GOOS == "linux" {
		unknown = filepath.Join(root, "indexed\ufffd")
	}
	if err := os.Mkdir(unknown, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(direct, bytes.Repeat([]byte("y"), 1<<20), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	process := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestDiskCommandProcess$")
	process.Env = append(os.Environ(), "HAPPIER_TEST_DISK_COMMAND=disk-scan", "HAPPIER_TEST_DISK_BLOCK="+child)
	request, _ := json.Marshal(map[string]any{"root": diskPathID(root), "previousIndexPath": prior, "relistOnly": true, "drawableNodes": 100, "scratchDirectory": storageRenameTestRoot(t)})
	process.Stdin = bytes.NewReader(append(request, '\n'))
	var diagnostic bytes.Buffer
	process.Stderr = &diagnostic
	output, err := process.Output()
	if err != nil {
		t.Fatalf("direct relist did not retire without opening the blocked indexed child: %v; stderr=%s", err, diagnostic.String())
	}
	output = diskCollectScanFixture(t, output)
	var final diskDirRecord
	var retained, directIDs []string
	unknownMetadataSeen := false
	for _, line := range bytes.Split(bytes.TrimSpace(output), []byte{'\n'}) {
		var record diskDirRecord
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatal(err)
		}
		if record.Type != "dir" {
			continue
		}
		if record.ID != diskPathID(root) {
			t.Fatalf("one-folder relist enumerated a nested subtree: %s", line)
		}
		final = record
		var facts struct{ RetainedSubtrees, DirectChildIds []string }
		if err := json.Unmarshal(line, &facts); err != nil {
			t.Fatal(err)
		}
		retained, directIDs = facts.RetainedSubtrees, facts.DirectChildIds
		if len(directIDs) != 3 || len(retained) != 1 || retained[0] != diskPathID(child) {
			t.Fatalf("initial/final relist record lacks preservation facts: %s", line)
		}
		for _, node := range record.Children {
			if node.ID == diskPathID(unknown) && node.Flags.AtLeast {
				unknownMetadataSeen = true
			}
		}
	}
	if !final.Enumerated || final.Complete || !final.Flags.AtLeast || len(final.Files) != 1 || final.Files[0].AllocatedBytes < 1<<20 || !unknownMetadataSeen {
		t.Fatalf("direct relist failed fresh-file/partial-subtree honesty: %s", output)
	}
	if len(retained) != 1 || retained[0] != diskPathID(child) || len(directIDs) != 3 {
		t.Fatalf("direct relist lost retained subtree or unpruned direct-name facts: %s", output)
	}
	for _, node := range final.Children {
		if node.ID == diskPathID(child) && node.AllocatedBytes != oldChild.AllocatedBytes {
			t.Fatalf("direct relist discarded the indexed child aggregate: %#v", node)
		}
		if node.ID == diskPathID(unknown) {
			t.Fatalf("small unindexed child fixture was not folded: %#v", node)
		}
	}
}

func TestDiskScanOwnerRelistEmptyDirectoryFacts(t *testing.T) {
	root := storageRenameTestRoot(t)
	output := runDiskOwner(t, "disk-scan", diskScanRequest{Root: root, RelistOnly: true})
	found := false
	for _, line := range bytes.Split(bytes.TrimSpace(output), []byte{'\n'}) {
		var record diskDirRecord
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatal(err)
		}
		if record.Type != "dir" {
			continue
		}
		if record.DirectChildIDs == nil || len(*record.DirectChildIDs) != 0 || !record.Enumerated {
			t.Fatalf("empty relist lacks authoritative empty direct-name facts: %s", line)
		}
		if record.Complete {
			found = true
			if record.Flags.AtLeast {
				t.Fatalf("fresh empty subtree incorrectly claimed incomplete: %s", line)
			}
		}
	}
	if !found {
		t.Fatalf("empty direct relist did not publish fresh subtree coverage: %s", output)
	}
}

func TestDiskScanOwnerEpochAgeSentinel(t *testing.T) {
	for _, stampMs := range []int64{1000, 2000} {
		root := storageRenameTestRoot(t)
		leaf := filepath.Join(root, "old")
		if err := os.WriteFile(leaf, bytes.Repeat([]byte("x"), 8192), 0600); err != nil {
			t.Fatal(err)
		}
		stamp := time.UnixMilli(stampMs)
		if err := os.Chtimes(leaf, stamp, stamp); err != nil {
			t.Fatal(err)
		}
		observed, err := os.Stat(leaf)
		if err != nil || observed.ModTime().UnixMilli() != stampMs {
			t.Fatalf("epoch fixture was not observed by the filesystem: stat=%v, error=%v", observed, err)
		}
		output := runDiskOwner(t, "disk-scan", diskScanRequest{Root: root})
		var final diskDirRecord
		for _, line := range bytes.Split(bytes.TrimSpace(output), []byte{'\n'}) {
			var record diskDirRecord
			if err := json.Unmarshal(line, &record); err != nil {
				t.Fatal(err)
			}
			if record.Type == "dir" && record.ID == root {
				final = record
			}
		}
		if stampMs == 1000 && (final.AgeGroupBytes.Unknown < 8192 || final.AgeGroupBytes.Months12 != 0) {
			t.Fatalf("reproducible-build epoch sentinel was classified old: %#v", final.AgeGroupBytes)
		}
		if stampMs > 1000 && (final.AgeGroupBytes.Unknown != 0 || final.AgeGroupBytes.Months12 < 8192) {
			t.Fatalf("positive timestamp beyond epoch sentinel was classified unknown: %#v", final.AgeGroupBytes)
		}
	}
}

func TestDiskScanInvalidIndexDiagnostic(t *testing.T) {
	root := t.TempDir()
	encoded, err := json.Marshal(diskScanRequest{Root: root, PreviousIndexPath: filepath.Join(root, "index.sqlite"), ScratchDirectory: storageRenameTestRoot(t)})
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestDiskCommandProcess$")
	child.Env = append(os.Environ(), "HAPPIER_TEST_DISK_COMMAND=disk-scan")
	child.Stdin = bytes.NewReader(append(encoded, '\n'))
	var stderr bytes.Buffer
	child.Stderr = &stderr
	output, err := child.Output()
	if err == nil || child.ProcessState.ExitCode() != exitOSError {
		t.Fatalf("unsupported index did not fail before scan: error=%v, stdout=%s", err, output)
	}
	// The approved permission preprobe precedes prior-index ingestion, but a
	// failed prior input must not publish any filesystem scan records.
	for _, line := range bytes.Split(bytes.TrimSpace(output), []byte{'\n'}) {
		var record struct{ Type string }
		if err := json.Unmarshal(line, &record); err != nil || record.Type != "permission" {
			t.Fatalf("invalid prior input published a filesystem scan record: %s", line)
		}
	}
	var diagnostic map[string]any
	if err := json.Unmarshal(stderr.Bytes(), &diagnostic); err != nil {
		t.Fatalf("unsupported index lacks a typed subprocess diagnostic: %s", stderr.String())
	}
	if len(diagnostic) != 3 || diagnostic["v"] != float64(1) || diagnostic["code"] != "native_disk_invalid_previous_index" || diagnostic["message"] == "" {
		t.Fatalf("unexpected unsupported diagnostic: %#v", diagnostic)
	}
}

// These are native attribute facts, not substituted owner functions. The same
// canonical aggregation consumes this shape after the real platform walk.
func diskFactWalk(root string, facts map[string]diskMetadata) diskWalkResult {
	walk := diskWalkResult{observations: map[string]*diskObservation{}, incomplete: map[string]bool{}}
	for path, meta := range facts {
		diskObserve(&walk, root, path, meta)
	}
	return walk
}

func TestDiskMeasureSingletonRetentionAndOverlappingTraversal(t *testing.T) {
	root := storageRenameTestRoot(t)
	nested := filepath.Join(root, "nested")
	if err := os.Mkdir(nested, 0700); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 200; index++ {
		if err := os.WriteFile(filepath.Join(nested, fmt.Sprintf("file-%04d", index)), []byte("ordinary"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	opened := 0
	previous := diskOpenDirectoryForScan
	diskOpenDirectoryForScan = func(path string) (diskDirectory, error) { opened++; return diskOpenRoot(path) }
	defer func() { diskOpenDirectoryForScan = previous }()
	walk, err := diskWalk(context.Background(), []string{root, nested}, false, diskScanRequest{measureLinkCounts: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(walk.observations) > 2 {
		t.Fatalf("ordinary singleton identities retained: %d", len(walk.observations))
	}
	if opened != 2 {
		t.Fatalf("overlapping roots enumerated more than once: %d", opened)
	}
	measured := diskAggregateMeasure(walk, []string{root, nested}, diskMeasureRequest{})
	if measured.PerPath[1].Items != 201 || measured.PerPath[1].ExclusiveBytes == 0 {
		t.Fatalf("lost nested singletons: %#v", measured)
	}
}

func TestDiskMeasureDistinctUnionsReuseOneWalk(t *testing.T) {
	root := storageRenameTestRoot(t)
	a, b := filepath.Join(root, "a"), filepath.Join(root, "b")
	for _, path := range []string{a, b} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	file := filepath.Join(a, "shared")
	if err := os.WriteFile(file, bytes.Repeat([]byte("x"), 8192), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(file, filepath.Join(b, "link")); err != nil {
		t.Skipf("hardlinks unavailable: %v", err)
	}
	var opened atomic.Int64
	previous := diskOpenDirectoryForScan
	diskOpenDirectoryForScan = func(path string) (diskDirectory, error) { opened.Add(1); return diskOpenRoot(path) }
	defer func() { diskOpenDirectoryForScan = previous }()
	request := diskMeasureRequest{Paths: []string{root, a, b}, Unions: []diskMeasureUnion{{ID: "both", Paths: []string{a, b}}, {ID: "first", Paths: []string{a}}, {ID: "nested", Paths: []string{root, a}}}}
	measured, err := diskMeasure(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if opened.Load() != 3 {
		t.Fatalf("union traversal amplified: %d", opened.Load())
	}
	if len(measured.Unions) != 3 {
		t.Fatalf("missing union totals: %#v", measured)
	}
	for index, union := range request.Unions {
		independent, err := diskMeasure(context.Background(), diskMeasureRequest{Paths: union.Paths})
		if err != nil {
			t.Fatal(err)
		}
		if measured.Unions[index].TotalAllocatedBytes != independent.TotalAllocatedBytes || measured.Unions[index].TotalExclusiveBytes != independent.TotalExclusiveBytes {
			t.Fatalf("union %s differs from independent owner: %#v vs %#v", union.ID, measured.Unions[index], independent)
		}
	}
}

func TestDiskMeasureIncompleteSelectedRootDoesNotInvalidateReadableUnionMembers(t *testing.T) {
	root := storageRenameTestRoot(t)
	if err := os.WriteFile(filepath.Join(root, "ordinary"), bytes.Repeat([]byte("x"), 8192), 0600); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(root, "missing")
	expected, err := diskMeasure(context.Background(), diskMeasureRequest{Paths: []string{root}})
	if err != nil {
		t.Fatal(err)
	}
	measured, err := diskMeasure(context.Background(), diskMeasureRequest{Paths: []string{root, missing}, Unions: []diskMeasureUnion{{ID: "eligible", Paths: []string{root, missing}, ExcludeIncomplete: true}}})
	if err != nil {
		t.Fatal(err)
	}
	if measured.PerPath[0].AtLeast || len(measured.Unions) != 1 || !measured.Unions[0].AtLeast || measured.Unions[0].TotalExclusiveBytes != expected.TotalExclusiveBytes {
		t.Fatalf("missing selected root invalidated independently readable union member: %#v expected %#v", measured, expected)
	}
}

func TestDiskMeasureCloneDataStreamDistinctPrivateForkAllocations(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "root")
	first := diskMetadata{kind: "file", device: "apfs", identity: "inode1", cloneID: "family", nlink: 1, allocatedBytes: 12288, privateBytes: 4096, privateBytesKnown: true, mayShareBlocks: true, extFlagsKnown: true, cloneRefCount: 2}
	second := first
	second.identity = "inode2"
	result := diskAggregateMeasure(diskFactWalk(root, map[string]diskMetadata{filepath.Join(root, "a"): first, filepath.Join(root, "b"): second}), []string{root}, diskMeasureRequest{})
	if result.TotalAllocatedBytes != 24576 || result.TotalExclusiveBytes != 8192 || result.PerPath[0].ExclusiveBytes != 8192 {
		t.Fatalf("same data stream collapsed distinct private fork allocations: %#v", result)
	}
}

func TestDiskForeignDeviceBoundaryHasReason(t *testing.T) {
	skip, reason := diskDirectoryBoundary("other", "root", nil, false, "")
	if !skip || reason != "foreign_device" {
		t.Fatalf("foreign-device leaf lost explicit reason: skip=%v reason=%q", skip, reason)
	}
	skip, reason = diskDirectoryBoundary("containerVolume", "root", []string{"containerVolume"}, false, "")
	if skip {
		t.Fatalf("canonical container member was excluded: %q", reason)
	}
}

func TestDiskMeasureCloneFamilyCannotSupplyMissingHardlink(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "root")
	first := diskMetadata{kind: "file", device: "apfs", identity: "inode1", cloneID: "family", nlink: 2, allocatedBytes: 4096}
	second := first
	second.identity, second.nlink = "inode2", 1
	result := diskAggregateMeasure(diskFactWalk(root, map[string]diskMetadata{filepath.Join(root, "a"): first, filepath.Join(root, "b"): second}), []string{root}, diskMeasureRequest{})
	if result.TotalAllocatedBytes != 8192 || result.TotalExclusiveBytes != 4096 {
		t.Fatalf("different clone inode incorrectly satisfied outside hardlink: %#v", result)
	}
}

func TestDiskMeasureFullClonesRetainPerInodeLinkEvidence(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "root")
	first := diskMetadata{kind: "file", device: "apfs", identity: "inode1", cloneID: "family", nlink: 2, allocatedBytes: 4096, dataAllocatedBytes: 4096, dataAllocationKnown: true, privateBytesKnown: true, mayShareBlocks: true, sharesAllBlocks: true, extFlagsKnown: true, cloneRefCount: 2}
	second := first
	second.identity, second.nlink = "inode2", 1
	result := diskAggregateMeasure(diskFactWalk(root, map[string]diskMetadata{filepath.Join(root, "a"): first, filepath.Join(root, "b"): second}), []string{root}, diskMeasureRequest{})
	if result.TotalAllocatedBytes != 4096 || result.PerPath[0].FreesUpToBytes == nil || *result.PerPath[0].FreesUpToBytes != 0 {
		t.Fatalf("full clone family outside link overclaimed upper reclaimability: %#v", result)
	}
}

func TestDiskMeasureSharedDataRetainsDistinctResourceForkAndUpperBound(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "root")
	clonePath, originalPath := filepath.Join(root, "a-clone"), filepath.Join(root, "z-original")
	clone := diskMetadata{kind: "file", device: "apfs", identity: "inode1", cloneID: "stream", nlink: 1, allocatedBytes: 8192, dataAllocatedBytes: 8192, dataAllocationKnown: true, privateBytesKnown: true, mayShareBlocks: true, sharesAllBlocks: true, extFlagsKnown: true, cloneRefCount: 2}
	original := clone
	original.identity, original.allocatedBytes = "inode2", 40960
	walk := diskWalkResult{observations: map[string]*diskObservation{}, incomplete: map[string]bool{}}
	diskObserve(&walk, clonePath, clonePath, clone)
	diskObserve(&walk, originalPath, originalPath, original)
	result := diskAggregateMeasure(walk, []string{clonePath, originalPath}, diskMeasureRequest{})
	if result.TotalAllocatedBytes != 40960 || walk.summary.AllocatedBytes != 40960 || result.PerPath[1].AllocatedBytes != 32768 {
		t.Fatalf("shared data erased a distinct inode resource fork: %#v; summary %#v", result, walk.summary)
	}
	if result.TotalExclusiveBytes != 0 || result.PerPath[1].FreesUpToBytes == nil || *result.PerPath[1].FreesUpToBytes != 32768 {
		t.Fatalf("outside data clone suppressed independent fork upper bound or snapshot uncertainty: %#v", result)
	}
	// A hardlink outside the selected original still prevents reclaiming its fork.
	original.nlink = 2
	walk = diskFactWalk(originalPath, map[string]diskMetadata{originalPath: original})
	result = diskAggregateMeasure(walk, []string{originalPath}, diskMeasureRequest{})
	if result.PerPath[0].FreesUpToBytes == nil || *result.PerPath[0].FreesUpToBytes != 0 {
		t.Fatalf("outside inode hardlink allowed resource-fork reclaim: %#v", result)
	}
}

func TestDiskMeasureUnknownDataSplitPreservesAllForkUpperBound(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "root")
	meta := diskMetadata{kind: "file", device: "apfs", identity: "inode", cloneID: "stream", nlink: 1, allocatedBytes: 40960, privateBytesKnown: true, mayShareBlocks: true, sharesAllBlocks: true, extFlagsKnown: true, cloneRefCount: 2}
	result := diskAggregateMeasure(diskFactWalk(root, map[string]diskMetadata{root: meta}), []string{root}, diskMeasureRequest{})
	if result.PerPath[0].ExclusiveBytes != 0 || result.PerPath[0].FreesUpToBytes == nil || *result.PerPath[0].FreesUpToBytes != 40960 {
		t.Fatalf("unknown split falsely excluded potentially private forks: %#v", result)
	}
}

func TestDiskMeasureUnmeasuredSharingCannotPromiseExclusive(t *testing.T) {
	root := filepath.Join(string(filepath.Separator), "root")
	meta := diskMetadata{kind: "file", identity: "inode", nlink: 1, allocatedBytes: 8192, sharedExtentsUnmeasured: true}
	result := diskAggregateMeasure(diskFactWalk(root, map[string]diskMetadata{root: meta}), []string{root}, diskMeasureRequest{})
	size := result.PerPath[0]
	if result.TotalExclusiveBytes != 0 || size.ExclusiveBytes != 0 || !size.SharedExtentsUnmeasured || size.FreesUpToBytes == nil || *size.FreesUpToBytes != 8192 {
		t.Fatalf("unmeasured sharing promised reclaimability: %#v", result)
	}
}

func TestDiskMeasureUnsupportedExtentProbePreservesUnknown(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("Linux owns the actual FIEMAP probe")
	}
	root := filepath.Join(string(filepath.Separator), "root")
	meta := diskMetadata{kind: "file", identity: "inode", nlink: 1, allocatedBytes: 8192, sharedExtentsUnmeasured: true, privateBytesKnown: true}
	result := diskAggregateMeasure(diskFactWalk(root, map[string]diskMetadata{root: meta}), []string{root}, diskMeasureRequest{MeasureSharedExtents: true})
	if !result.PerPath[0].SharedExtentsUnmeasured || result.TotalExclusiveBytes != 0 {
		t.Fatalf("unsupported extent probe falsely resolved sharing: %#v", result)
	}
}
