package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
	"unsafe"
)

type diskEntryRecord struct {
	V            int      `json:"v"`
	Type         string   `json:"type"`
	Parent       string   `json:"parent"`
	Node         diskNode `json:"node"`
	Visible      bool     `json:"visible"`
	Retained     bool     `json:"retained"`
	ReplaceFacts bool     `json:"replaceFacts"`
}
type diskFactRecord struct {
	V     int                `json:"v"`
	Type  string             `json:"type"`
	Owner string             `json:"owner"`
	Fact  diskAllocationFact `json:"fact"`
}
type diskStreamDirectory struct {
	record                     diskDirRecord
	facts                      []diskAllocationFact
	rangeHead, rangeTail       int64
	pending                    int
	enumerationDone, published bool
	enumerationError           bool
	lastActivity               time.Time
}

var diskScanNow = time.Now
var diskScanProgressTicks = func() (<-chan time.Time, func()) {
	ticker := time.NewTicker(100 * time.Millisecond)
	return ticker.C, ticker.Stop
}

// Approved scan presentation: only name stalled work after ten seconds with
// no completed metadata batch. This is an observation threshold, not a timeout.
const diskScanStuckAfter = 10 * time.Second

func diskStreamProgress(now time.Time, summary diskSummary, inFlight map[string]*diskStreamDirectory) diskProgress {
	path := ""
	var oldest time.Time
	for candidate, directory := range inFlight {
		if path == "" || directory.lastActivity.Before(oldest) || directory.lastActivity.Equal(oldest) && candidate < path {
			path, oldest = candidate, directory.lastActivity
		}
	}
	progress := diskProgress{V: 1, Type: "progress", SizedBytes: summary.AllocatedBytes, Items: summary.Items, CurrentPath: diskPathID(path)}
	if path != "" && now.Sub(oldest) >= diskScanStuckAfter {
		progress.StuckSinceMs = oldest.UnixMilli()
	}
	return progress
}

type diskStreamBatch struct {
	directory *diskStreamDirectory
	entries   []diskEntry
	backend   string
	err       error
	done      bool
}

// This is a reusable transport buffer, not a file/directory count limit. Every
// entry is delivered; converting a 64 KiB name batch must not queue megabytes of
// expanded metadata behind a slow consumer.
type diskEntryBuffer struct {
	entries []diskEntry
	bytes   int
	visit   func([]diskEntry) error
}

func (buffer *diskEntryBuffer) append(entry diskEntry) error {
	buffer.entries = append(buffer.entries, entry)
	buffer.bytes += int(unsafe.Sizeof(entry)) + len(entry.name) + len(entry.path) + len(entry.meta.identity) + len(entry.meta.device)
	if buffer.bytes >= 64*1024 {
		return buffer.flush()
	}
	return nil
}
func (buffer *diskEntryBuffer) flush() error {
	if len(buffer.entries) == 0 {
		return nil
	}
	items := buffer.entries
	buffer.entries = nil
	buffer.bytes = 0
	return buffer.visit(items)
}

// Scan is an incremental producer. Only in-flight worker state and aggregate
// buffers remain resident; directory headers, frontier, raw entries and exact
// physical-component ownership are disk-backed.
// Measure retains its different exclusive-link accounting in diskWalk.
func diskScanStream(ctx context.Context, control *diskControl, request diskScanRequest, emit func(any) error) error {
	if !filepath.IsAbs(request.ScratchDirectory) || request.ScratchDirectory == request.Root {
		return errors.New("disk-scan requires its host-owned absolute scratch directory")
	}
	scratch, err := os.Lstat(request.ScratchDirectory)
	if err != nil || !scratch.IsDir() || scratch.Mode()&os.ModeSymlink != 0 {
		return errors.New("disk-scan scratch directory is unavailable")
	}
	// Reuse the platform's held/no-follow parent chain, rather than adding a
	// separate path confinement mechanism for this private filesystem boundary.
	held, err := diskOpenRoot(request.ScratchDirectory)
	if err != nil {
		return err
	}
	scratchIdentity := held.metadata().identity
	held.close()
	winners, err := diskNewWinnerSpool(request.ScratchDirectory)
	if err != nil {
		return err
	}
	defer winners.close()
	entries, err := diskNewEntrySpool(request.ScratchDirectory)
	if err != nil {
		return err
	}
	defer entries.close()
	directories, err := diskNewDirectorySpool(request.ScratchDirectory)
	if err != nil {
		return err
	}
	defer directories.close()
	visited, err := diskNewWinnerSpool(request.ScratchDirectory, "visited-directories")
	if err != nil {
		return err
	}
	defer visited.close()
	prior, err := diskNewWinnerSpool(request.ScratchDirectory, "prior-projection")
	if err != nil {
		return err
	}
	defer prior.close()
	discovery, err := diskNewPathSpool(request.ScratchDirectory, "directory-order")
	if err != nil {
		return err
	}
	defer discovery.close()
	priorFrontier, err := diskNewPathSpool(request.ScratchDirectory, "prior-frontier")
	if err != nil {
		return err
	}
	defer priorFrontier.close()
	queue, err := diskNewFrontierSpool(request.ScratchDirectory)
	if err != nil {
		return err
	}
	defer queue.close()
	inFlight := map[string]*diskStreamDirectory{}
	getDirectory := func(path string) (*diskStreamDirectory, error) {
		if directory := inFlight[path]; directory != nil {
			return directory, nil
		}
		return directories.get(path)
	}
	summary := diskEmptySummary()
	summary.PendingFrontier = []string{}
	issue := func(path, reason string) {
		summary.UnreadableCounts[reason]++
		if summary.UnreadableCounts[reason] == 1 {
			summary.Unreadable = append(summary.Unreadable, diskIssue{path, reason})
		}
	}
	if request.PreviousIndexPath != "" {
		if err := diskReadPrevious(request.PreviousIndexPath, request.Root, request.ResumeFrom != nil, func(row diskPriorRow, path string) error {
			switch row.Type {
			case "prior-observation":
				if request.ResumeFrom != nil {
					_, _, err := winners.observe(row.Key, path, *row.AllocatedBytes)
					return err
				}
			case "prior-frontier":
				if request.ResumeFrom != nil && len(request.ResumeFrom) == 0 {
					if err := prior.set("frontier:"+path, "1"); err != nil {
						return err
					}
					return priorFrontier.append(path)
				}
			case "prior-dir":
				return prior.set("directory:"+path, strconv.FormatInt(*row.AllocatedBytes, 10))
			case "prior-child":
				if request.RelistOnly || request.ResumeFrom != nil {
					data, err := json.Marshal(row)
					if err != nil {
						return err
					}
					return prior.set("child:"+path, string(data))
				}
			}
			return nil
		}); err != nil {
			return err
		}
	}
	for i, path := range request.PriorityHints {
		if err := prior.set("hint:"+path, strconv.Itoa(i)); err != nil {
			return err
		}
	}
	request.PriorityHints = nil
	priority := func(path string) (diskQueuedPath, error) {
		queued := diskQueuedPath{Path: diskPathID(path), Tier: 2}
		for ancestor := path; ; {
			value, found, err := prior.get("hint:" + ancestor)
			if err != nil {
				return queued, err
			}
			if found {
				queued.Tier = 0
				queued.Priority, err = strconv.ParseInt(value, 10, 64)
				return queued, err
			}
			parent := filepath.Dir(ancestor)
			if parent == ancestor {
				break
			}
			ancestor = parent
		}
		value, found, err := prior.get("directory:" + path)
		if err != nil {
			return queued, err
		}
		if found {
			size, err := strconv.ParseInt(value, 10, 64)
			queued.Tier = 1
			queued.Priority = -size
			return queued, err
		}
		return queued, nil
	}
	enqueue := func(directory *diskStreamDirectory) error {
		queued, err := priority(directory.record.rawPath)
		if err != nil {
			return err
		}
		if directory.record.Summarized || directory.record.atomicParent != "" {
			queued.Tier, queued.Priority = 0, 0
		}
		return queue.push(queued)
	}
	observe := func(path string, facts []diskAllocationFact) error {
		for index, fact := range facts {
			fresh, delta, err := winners.observe(fact.Key, path, fact.AllocatedBytes)
			if err != nil {
				return err
			}
			if fresh {
				summary.AllocatedBytes += delta
				if index == 0 {
					summary.Items++
				}
			}
		}
		return nil
	}
	// A resumed directory is a continuation when its own physical identity is
	// still the one in the retained index. Its already measured descendants
	// must survive rediscovery and another abrupt cancellation.
	priorDirectory := func(path string, facts []diskAllocationFact) (bool, error) {
		if request.ResumeFrom == nil || len(facts) == 0 {
			return false, nil
		}
		_, found, err := prior.get("directory:" + path)
		if err != nil || !found {
			return false, err
		}
		winner, observed, err := winners.get(facts[0].Key)
		return observed && winner == path, err
	}
	makeDirectory := func(path string, meta diskMetadata, atomicParent string) (*diskStreamDirectory, error) {
		node := diskNodeFromEntry(diskEntry{name: filepath.Base(path), path: path, meta: meta})
		record := diskDirRecord{V: 1, Type: "dir", ID: node.ID, Name: node.Name, NameBytes: node.NameBytes, OwnLogicalBytes: meta.logicalBytes, AllocatedBytes: meta.allocatedBytes, LogicalBytes: meta.logicalBytes, Items: 1, MtimeMs: meta.mtimeMs, Flags: node.Flags, Children: []diskNode{}, Files: []diskNode{}, Streamed: true, RelistOnly: request.RelistOnly, meta: meta, rawPath: path, atomicParent: atomicParent}
		if path != request.Root {
			record.Parent = diskPathID(filepath.Dir(path))
			record.Summarized = meta.kind == "folder" && atomicParent == "" && diskAtomicDirectory(path, request.AtomicRules)
		}
		directory := &diskStreamDirectory{record: record, facts: node.AllocationFacts}
		if err := directories.set(directory); err != nil {
			return nil, err
		}
		if err := discovery.append(path); err != nil {
			return nil, err
		}
		return directory, nil
	}
	writeFacts := func(owner string, facts []diskAllocationFact) error {
		for _, fact := range facts {
			if err := emit(diskFactRecord{1, "fact", diskPathID(owner), fact}); err != nil {
				return err
			}
		}
		return nil
	}
	startDirectory := func(directory *diskStreamDirectory, continuing bool) error {
		record := directory.record
		if record.atomicParent != "" {
			return nil
		}
		record.Type = "dir-start"
		// Until its subtree finishes this is a lower bound, even when the
		// directory's own metadata was readable.
		record.Flags.AtLeast = true
		if !continuing {
			if err := emit(struct {
				diskDirRecord
				RelistOnly bool `json:"relistOnly"`
			}{record, request.RelistOnly}); err != nil {
				return err
			}
		}
		return writeFacts(record.rawPath, directory.facts)
	}
	rootMeta, err := diskReadMetadata(request.Root)
	if err != nil {
		issue(request.Root, diskReason(err))
	} else {
		seed := func(path string) error {
			if control.skips(path) {
				summary.Skipped = append(summary.Skipped, diskIssue{path, "user"})
				return nil
			}
			meta := rootMeta
			if path != request.Root {
				meta, err = diskReadMetadata(path)
				if err != nil {
					issue(path, diskReason(err))
					return nil
				}
			}
			if meta.device != rootMeta.device && !diskAllowedDevice(request.AllowedDevices, meta.device) {
				summary.Skipped = append(summary.Skipped, diskIssue{path, "foreign_device"})
				return nil
			}
			facts := diskAllocationFacts(path, meta)
			if meta.cloudOnly {
				facts = nil
			}
			continuing, err := priorDirectory(path, facts)
			if err != nil {
				return err
			}
			if err := observe(path, facts); err != nil {
				return err
			}
			_, seen, err := visited.get(meta.identity)
			if err != nil {
				return err
			}
			if (meta.kind == "folder" || meta.kind == "package") && !meta.cloudOnly && !seen {
				if err := visited.set(meta.identity, "1"); err != nil {
					return err
				}
				directory, err := makeDirectory(path, meta, "")
				if err != nil {
					return err
				}
				if err := startDirectory(directory, continuing); err != nil {
					return err
				}
				return enqueue(directory)
			}
			return nil
		}
		if request.ResumeFrom == nil {
			if err := seed(request.Root); err != nil {
				return err
			}
		} else if len(request.ResumeFrom) > 0 {
			for _, path := range request.ResumeFrom {
				if err := seed(path); err != nil {
					return err
				}
			}
		} else {
			if err := priorFrontier.visit(false, func(path string) error {
				for ancestor := filepath.Dir(path); ancestor != path; ancestor = filepath.Dir(ancestor) {
					_, covered, err := prior.get("frontier:" + ancestor)
					if err != nil {
						return err
					}
					if covered {
						return nil
					}
					if filepath.Dir(ancestor) == ancestor {
						break
					}
				}
				return seed(path)
			}); err != nil {
				return err
			}
		}
	}
	workers := diskWorkerCount(request.LowPower)
	workerCtx, cancelWorkers := context.WithCancel(ctx)
	defer cancelWorkers()
	jobs := make(chan *diskStreamDirectory)
	batches := make(chan diskStreamBatch)
	var group sync.WaitGroup
	send := func(batch diskStreamBatch) error {
		select {
		case batches <- batch:
			return nil
		case <-workerCtx.Done():
			return workerCtx.Err()
		}
	}
	for i := 0; i < workers; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for directory := range jobs {
				batch := diskStreamBatch{directory: directory, done: true}
				if !control.skips(directory.record.rawPath) {
					dir, err := diskOpenDirectoryForScan(directory.record.rawPath)
					if err != nil {
						batch.err = err
					} else {
						if dir.metadata().identity != directory.record.meta.identity {
							batch.err = errors.New("directory changed before enumeration")
						} else {
							visit := func(items []diskEntry) error { return send(diskStreamBatch{directory: directory, entries: items}) }
							if scanner, ok := dir.(interface {
								entryBatches(context.Context, func([]diskEntry) error) (string, error)
							}); ok {
								batch.backend, batch.err = scanner.entryBatches(workerCtx, visit)
							} else {
								var items []diskEntry
								items, batch.backend, batch.err = dir.entries(workerCtx)
								if len(items) > 0 {
									if err := visit(items); err != nil {
										batch.err = err
									}
								}
							}
						}
						dir.close()
					}
				}
				if send(batch) != nil {
					return
				}
			}
		}()
	}
	retired := true
	defer func() {
		cancelWorkers()
		close(jobs)
		if !retired {
			group.Wait()
		}
	}()
	now := time.Now()
	lastProgress := time.Time{}
	var publishedProgress diskProgress
	reportProgress := func() error {
		current := diskScanNow()
		if current.Sub(lastProgress) < 100*time.Millisecond {
			return nil
		}
		progress := diskStreamProgress(current, summary, inFlight)
		if progress == publishedProgress {
			return nil
		}
		if err := emit(progress); err != nil {
			return err
		}
		publishedProgress = progress
		lastProgress = current
		return nil
	}
	// A record is projected using bounded passes over its own direct entries.
	// No completed-leaf pass aggregates all physical observations or other dirs.
	project := func(directory *diskStreamDirectory, publish bool) error {
		record := &directory.record
		record.AllocatedBytes, record.LogicalBytes, record.Items = 0, record.OwnLogicalBytes, 1
		record.AgeGroupBytes = diskAgeGroups{}
		record.Folded = diskFolded{}
		record.Complete = directory.enumerationDone && record.Enumerated && directory.pending == 0
		for _, fact := range directory.facts {
			owned, err := winners.owns(fact, record.rawPath)
			if err != nil {
				return err
			}
			if owned {
				record.AllocatedBytes += fact.AllocatedBytes
			}
		}
		update := func(node diskNode) (diskNode, error) {
			node.AllocatedBytes = 0
			if node.Kind == "mount" || node.Kind == "cloud-only" {
				return node, nil
			}
			for _, fact := range node.AllocationFacts {
				owned, err := winners.owns(fact, node.rawPath)
				if err != nil {
					return node, err
				}
				if owned {
					node.AllocatedBytes += fact.AllocatedBytes
				}
			}
			if prior := node.retained; prior != nil {
				node.AllocatedBytes, node.LogicalBytes, node.Items, node.Flags = prior.allocatedBytes, prior.logicalBytes, prior.items, prior.flags
			} else if node.Kind == "folder" || node.Kind == "package" {
				child, err := getDirectory(node.rawPath)
				if err != nil {
					return node, err
				}
				if child != nil {
					node.AllocatedBytes, node.LogicalBytes, node.Items, node.Flags = child.record.AllocatedBytes, child.record.LogicalBytes, child.record.Items, child.record.Flags
				}
			}
			return node, nil
		}
		if err := directories.visit(entries, directory, func(node diskNode) error {
			node, err := update(node)
			if err != nil {
				return err
			}
			record.AllocatedBytes += node.AllocatedBytes
			record.LogicalBytes += node.LogicalBytes
			record.Items += node.Items
			record.Flags.AtLeast = record.Flags.AtLeast || node.Flags.AtLeast
			if prior := node.retained; prior != nil {
				diskAddAge(&record.AgeGroupBytes, prior.ageGroups)
				record.Complete = record.Complete && !request.RelistOnly
			} else if node.Kind == "folder" || node.Kind == "package" {
				child, err := getDirectory(node.rawPath)
				if err != nil {
					return err
				}
				if child != nil {
					diskAddAge(&record.AgeGroupBytes, child.record.AgeGroupBytes)
					if !child.record.Complete {
						record.Complete = false
					}
				} else {
					record.Complete = false
				}
			}
			if node.Kind == "file" {
				diskAccumulateAge(&record.AgeGroupBytes, node.MtimeMs, node.AllocatedBytes, now)
			}
			directory.lastActivity = diskScanNow()
			return reportProgress()
		}); err != nil {
			return err
		}
		if record.Flags.AtLeast {
			record.Complete = false
		}
		threshold := request.KeepMinBytes
		if request.DrawableNodes > 0 {
			threshold = record.AllocatedBytes / request.DrawableNodes
		}
		if err := directories.visit(entries, directory, func(node diskNode) error {
			node, err := update(node)
			if err != nil {
				return err
			}
			// Keep folder navigation available while sizes are still arriving.
			// The completed parent applies the ordinary fold threshold once its
			// total is known; atomic/package descendants remain hidden below.
			visible := directory.pending > 0 && (node.Kind == "folder" || node.Kind == "package") || node.AllocatedBytes >= threshold || node.Kind == "mount" || node.Kind == "cloud-only" || node.Kind == "symlink"
			if !visible {
				record.Folded.Items += node.Items
				record.Folded.AllocatedBytes += node.AllocatedBytes
				record.Folded.LogicalBytes += node.LogicalBytes
			}
			if publish && (record.atomicParent == "" && record.meta.kind != "package" && !record.Summarized || node.Kind == "file") {
				if node.Kind == "folder" || node.Kind == "package" {
					child, err := getDirectory(node.rawPath)
					if err != nil {
						return err
					}
					node.Flags.AtLeast = node.Flags.AtLeast || node.retained == nil && (child == nil || !child.record.Complete)
				}
				node.AllocationFacts = nil
				if err := emit(diskEntryRecord{1, "dir-entry", record.ID, node, visible && record.atomicParent == "" && !record.Summarized && record.meta.kind != "package", node.retained != nil && request.RelistOnly, false}); err != nil {
					return err
				}
			}
			directory.lastActivity = diskScanNow()
			return reportProgress()
		}); err != nil {
			return err
		}
		if record.meta.kind == "package" || record.Summarized {
			record.Folded = diskFolded{Items: record.Items - 1, AllocatedBytes: record.AllocatedBytes - record.meta.allocatedBytes, LogicalBytes: record.LogicalBytes - record.OwnLogicalBytes}
		}
		if err := directories.set(directory); err != nil {
			return err
		}
		if publish && record.atomicParent == "" {
			projected := *record
			projected.Flags.AtLeast = projected.Flags.AtLeast || !projected.Complete
			return emit(projected)
		}
		return nil
	}
	finish := func(directory *diskStreamDirectory) error {
		for directory != nil && directory.enumerationDone && directory.pending == 0 && !directory.published {
			if err := project(directory, true); err != nil {
				return err
			}
			directory.published = true
			if err := directories.set(directory); err != nil {
				return err
			}
			parentPath := filepath.Dir(directory.record.rawPath)
			if parentPath == directory.record.rawPath {
				break
			}
			parent, err := getDirectory(parentPath)
			if err != nil {
				return err
			}
			if parent != nil {
				parent.pending--
				if err := directories.set(parent); err != nil {
					return err
				}
			}
			directory = parent
		}
		return nil
	}
	heartbeat, stopHeartbeat := diskScanProgressTicks()
	defer stopHeartbeat()
	pendingPaths, err := diskNewPathSpool(request.ScratchDirectory, "pending-paths")
	if err != nil {
		return err
	}
	defer pendingPaths.close()
	var waiting *diskStreamDirectory
	interrupt := func(termination string) error {
		retired = true
		summary.Termination = termination
		control.mu.RLock()
		for path := range control.skipped {
			summary.Skipped = append(summary.Skipped, diskIssue{path, "user"})
		}
		control.mu.RUnlock()
		remember := func(directory *diskStreamDirectory) error {
			path := directory.record.rawPath
			if directory.record.atomicParent != "" {
				path = directory.record.atomicParent
			}
			directory.record.Flags.AtLeast = true
			if err := directories.set(directory); err != nil {
				return err
			}
			if !control.skips(path) {
				if err := prior.set("pending:"+path, "1"); err != nil {
					return err
				}
				return pendingPaths.append(path)
			}
			return nil
		}
		for _, directory := range inFlight {
			if err := remember(directory); err != nil {
				return err
			}
		}
		if waiting != nil {
			if err := remember(waiting); err != nil {
				return err
			}
			waiting = nil
		}
		for queue.count > 0 {
			queued, err := queue.pop()
			if err != nil {
				return err
			}
			path, err := diskPathFromID(queued.Path)
			if err != nil {
				return err
			}
			directory, err := getDirectory(path)
			if err != nil {
				return err
			}
			if err := remember(directory); err != nil {
				return err
			}
		}
		return nil
	}
walk:
	for queue.count > 0 || len(inFlight) > 0 || waiting != nil {
		var ready chan *diskStreamDirectory
		if waiting == nil && queue.count > 0 && len(inFlight) < workers {
			queued, err := queue.pop()
			if err != nil {
				return err
			}
			path, err := diskPathFromID(queued.Path)
			if err != nil {
				return err
			}
			waiting, err = directories.get(path)
			if err != nil {
				return err
			}
		}
		if waiting != nil && len(inFlight) < workers {
			ready = jobs
		}
		select {
		case ready <- waiting:
			waiting.lastActivity = diskScanNow()
			inFlight[waiting.record.rawPath] = waiting
			waiting = nil
		case <-ctx.Done():
			if err := interrupt("cancelled"); err != nil {
				return err
			}
			break walk
		case <-control.changed:
			if err := interrupt("interrupted"); err != nil {
				return err
			}
			break walk
		case <-heartbeat:
			if err := reportProgress(); err != nil {
				return err
			}
		case batch := <-batches:
			directory := batch.directory
			directory.lastActivity = diskScanNow()
			record := &directory.record
			if batch.done {
				delete(inFlight, record.rawPath)
				directory.enumerationDone = true
				if control.skips(record.rawPath) {
					summary.Skipped = append(summary.Skipped, diskIssue{record.rawPath, "user"})
					record.Flags.AtLeast = true
				} else if batch.err != nil {
					if !errors.Is(batch.err, context.Canceled) {
						issue(record.rawPath, diskReason(batch.err))
					}
					record.Flags.AtLeast = true
				} else {
					record.Enumerated = !directory.enumerationError
					summary.BackendByDirCounts[batch.backend]++
				}
				if err := directories.set(directory); err != nil {
					return err
				}
				// Direct enumeration is useful before the last child finishes:
				// persist its names and unfinished-child frontier now, so an abrupt
				// cancellation keeps completed siblings and resumes only pending work.
				if directory.pending > 0 {
					if err := project(directory, true); err != nil {
						return err
					}
				}
				if err := finish(directory); err != nil {
					return err
				}
				continue
			}
			span := diskSpoolRange{start: entries.end}
			for _, entry := range batch.entries {
				if entry.err != nil {
					directory.enumerationError = true
					issue(entry.path, diskReason(entry.err))
					entry.meta.kind = "other"
					record.Flags.AtLeast = true
				}
				node := diskNodeFromEntry(entry)
				isDirectory := entry.meta.kind == "folder" || entry.meta.kind == "package"
				continuing := false
				if isDirectory {
					continuing, err = priorDirectory(entry.path, node.AllocationFacts)
					if err != nil {
						return err
					}
				}
				skip, reason := diskShouldSkip(entry.path, request.Root, entry.meta)
				skip, reason = diskDirectoryBoundary(entry.meta.device, record.meta.device, request.AllowedDevices, skip, reason)
				if entry.path == request.ScratchDirectory || isDirectory && scratchIdentity != "" && entry.meta.identity == scratchIdentity {
					skip, reason = true, "scan_scratch"
					node.Flags.AtLeast = true
				}
				if control.skips(entry.path) {
					skip, reason = true, "user"
					node.Flags.AtLeast = true
				}
				_, seen, err := visited.get(entry.meta.identity)
				if err != nil {
					return err
				}
				if isDirectory && !entry.meta.cloudOnly && !request.RelistOnly && seen {
					skip, reason = true, "duplicate_directory"
				}
				if isDirectory && skip {
					node.Kind = "mount"
					node.AllocationFacts = nil
					node.AllocatedBytes = 0
					node.LogicalBytes = 0
					summary.Skipped = append(summary.Skipped, diskIssue{entry.path, reason})
				} else if isDirectory && !entry.meta.cloudOnly && (request.RelistOnly || request.ResumeFrom != nil) {
					record.Flags.AtLeast = record.Flags.AtLeast || request.RelistOnly
					data, found, err := prior.get("child:" + entry.path)
					if err != nil {
						return err
					}
					var cached diskPriorRow
					if found {
						if err := json.Unmarshal([]byte(data), &cached); err != nil {
							return err
						}
					}
					if found && cached.IdentityKey == diskAllocationKey(entry.path, entry.meta) {
						previous := diskPriorChild{cached.IdentityKey, *cached.AllocatedBytes, *cached.LogicalBytes, *cached.Items, *cached.Flags, *cached.AgeGroupBytes}
						node.retained = &previous
						node.AllocationFacts = nil
						node.AllocatedBytes, node.LogicalBytes, node.Items, node.Flags = previous.allocatedBytes, previous.logicalBytes, previous.items, previous.flags
					} else {
						node.Flags.AtLeast = true
					}
				}
				atomicOwner := record.atomicParent
				if atomicOwner == "" && (record.meta.kind == "package" || record.Summarized) {
					atomicOwner = record.rawPath
				}
				// Hidden scalar ancestry is still needed for ordinary-file queries
				// and explicit nested-folder replacements. Completed directory,
				// coverage and chart records stay outside the summary boundary.
				out := node
				out.AllocationFacts = nil
				visible := isDirectory && !skip && !entry.meta.cloudOnly && record.atomicParent == "" && record.meta.kind != "package" && !record.Summarized
				if visible && node.retained == nil {
					out.Flags.AtLeast = true
				}
				if err := emit(diskEntryRecord{1, "dir-entry", record.ID, out, visible, node.retained != nil && request.RelistOnly, node.retained == nil && !continuing}); err != nil {
					return err
				}
				if err := observe(entry.path, node.AllocationFacts); err != nil {
					return err
				}
				if err := writeFacts(entry.path, node.AllocationFacts); err != nil {
					return err
				}
				if err := entries.append(node); err != nil {
					return err
				}
				if isDirectory && !skip && !entry.meta.cloudOnly && !request.RelistOnly && node.retained == nil {
					if err := visited.set(entry.meta.identity, "1"); err != nil {
						return err
					}
					child, err := makeDirectory(entry.path, entry.meta, atomicOwner)
					if err != nil {
						return err
					}
					directory.pending++
					if err := startDirectory(child, continuing); err != nil {
						return err
					}
					if err := enqueue(child); err != nil {
						return err
					}
				}
				// A batch can take much longer than its enumeration under slow
				// spool/output I/O. Publish completed work at the same cadence
				// while consuming it, rather than waiting for the outer select.
				directory.lastActivity = diskScanNow()
				if err := reportProgress(); err != nil {
					return err
				}
			}
			span.end = entries.end
			if err := directories.appendRange(directory, span); err != nil {
				return err
			}
			if err := directories.set(directory); err != nil {
				return err
			}
		}
	}
	// Terminal replay reconciles an earlier completed subtree if a later raw-byte
	// lexical hardlink/clone winner appeared. Facts are never reset on this replay.
	if err := discovery.visit(true, func(path string) error {
		directory, err := directories.get(path)
		if err != nil {
			return err
		}
		return project(directory, true)
	}); err != nil {
		return err
	}
	if err := emit(struct {
		V    int    `json:"v"`
		Type string `json:"type"`
	}{1, "frontier-start"}); err != nil {
		return err
	}
	if err := pendingPaths.visit(false, func(path string) error {
		value, _, err := prior.get("pending:" + path)
		if err != nil {
			return err
		}
		if value == "emitted" {
			return nil
		}
		for ancestor := filepath.Dir(path); ancestor != path; ancestor = filepath.Dir(ancestor) {
			_, covered, err := prior.get("pending:" + ancestor)
			if err != nil {
				return err
			}
			if covered {
				return nil
			}
			if filepath.Dir(ancestor) == ancestor {
				break
			}
		}
		if err := prior.set("pending:"+path, "emitted"); err != nil {
			return err
		}
		return emit(struct {
			V    int    `json:"v"`
			Type string `json:"type"`
			Path string `json:"path"`
		}{1, "frontier-item", diskPathID(path)})
	}); err != nil {
		return err
	}
	summary.StreamedFrontier = true
	for i := range summary.Unreadable {
		summary.Unreadable[i].Path = diskPathID(summary.Unreadable[i].Path)
	}
	for i := range summary.Skipped {
		summary.Skipped[i].Path = diskPathID(summary.Skipped[i].Path)
	}
	err = emit(summary)
	if err == nil && summary.Termination == "completed" {
		retired = false
	}
	return err
}
func diskAddAge(target *diskAgeGroups, source diskAgeGroups) {
	target.Unknown += source.Unknown
	target.Months3 += source.Months3
	target.Months6 += source.Months6
	target.Months12 += source.Months12
}
