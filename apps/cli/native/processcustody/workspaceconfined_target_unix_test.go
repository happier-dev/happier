//go:build linux || darwin

package main

import (
	"bufio"
	"bytes"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

func runTargetCommand(t *testing.T, command func([]string, interface{ Read([]byte) (int, error) }, *bytes.Buffer) error, input string) workspaceTargetResult {
	t.Helper()
	var output bytes.Buffer
	if err := command(nil, strings.NewReader(input), &output); err != nil {
		t.Fatalf("command failed: %v", err)
	}
	var result workspaceTargetResult
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatalf("result is not JSON: %q", output.String())
	}
	return result
}

func meta(t *testing.T, root, relative, op string) workspaceTargetResult {
	request, _ := json.Marshal(map[string]any{"v": 1, "rootPath": root, "relativePath": relative, "op": op})
	return runTargetCommand(t, func(args []string, in interface{ Read([]byte) (int, error) }, out *bytes.Buffer) error {
		return workspaceConfinedMetaCommand(args, in, out)
	}, string(request)+"\n")
}

func write(t *testing.T, root string, fields map[string]any, content string) workspaceTargetResult {
	fields["v"], fields["rootPath"] = 1, root
	if fields["op"] == "put" {
		fields["sizeBytes"] = len(content)
	}
	request, _ := json.Marshal(fields)
	return runTargetCommand(t, func(args []string, in interface{ Read([]byte) (int, error) }, out *bytes.Buffer) error {
		return workspaceConfinedWriteCommand(args, in, out)
	}, string(request)+"\n"+content)
}

func TestWorkspaceTargetRmdirPreservesNonemptyDirectories(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "reserved")
	must(t, os.Mkdir(directory, 0o700))
	must(t, os.WriteFile(filepath.Join(directory, "retained"), []byte("work"), 0o600))
	if result := write(t, root, map[string]any{"op": "rmdir", "relativePath": "reserved"}, ""); result.Code != "not_empty" {
		t.Fatalf("nonempty directory must remain: %+v", result)
	}
	content, err := os.ReadFile(filepath.Join(directory, "retained"))
	must(t, err)
	if string(content) != "work" {
		t.Fatal("retained work changed")
	}
	must(t, os.Remove(filepath.Join(directory, "retained")))
	if result := write(t, root, map[string]any{"op": "rmdir", "relativePath": "reserved"}, ""); result.Status != "done" {
		t.Fatalf("empty directory removal: %+v", result)
	}
	if _, err := os.Lstat(directory); !os.IsNotExist(err) {
		t.Fatalf("empty directory remains: %v", err)
	}
	if result := write(t, root, map[string]any{"op": "rmdir", "relativePath": "reserved"}, ""); result.Status != "missing" {
		t.Fatalf("missing directory removal: %+v", result)
	}
}

func TestWorkspaceTargetMetaListsStatsAndResolvesInsideTheRootOnly(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "ws")
	must(t, os.MkdirAll(filepath.Join(root, "src", "deep"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "src", "a.txt"), []byte("hello"), 0o644))
	must(t, os.WriteFile(filepath.Join(parent, "secret"), []byte("outside"), 0o600))
	must(t, os.Symlink("src/a.txt", filepath.Join(root, "inside-link")))
	must(t, os.Symlink(filepath.Join(root, "src"), filepath.Join(root, "abs-inside")))
	must(t, os.Symlink("../secret", filepath.Join(root, "escape")))
	must(t, os.Symlink("/etc", filepath.Join(root, "etc")))
	must(t, os.Symlink("loop", filepath.Join(root, "loop")))

	listed := meta(t, root, "", "list")
	if listed.Status != "entries" {
		t.Fatalf("list root: %+v", listed)
	}
	kinds := map[string]string{}
	for _, entry := range listed.Entries {
		kinds[entry.Name] = entry.Kind
	}
	if kinds["src"] != "directory" || kinds["inside-link"] != "symlink" || kinds["escape"] != "symlink" {
		t.Fatalf("kinds: %v", kinds)
	}
	// A single page supplies the same browse metadata as an individual stat,
	// including a confined link, without disclosing stat data outside the root.
	var sourceFile, insideLink, escapeLink map[string]json.RawMessage
	decodeEntry := func(entry workspaceTargetListEntry) map[string]json.RawMessage {
		encoded, err := json.Marshal(entry)
		must(t, err)
		var fields map[string]json.RawMessage
		must(t, json.Unmarshal(encoded, &fields))
		return fields
	}
	for _, entry := range listed.Entries {
		switch entry.Name {
		case "inside-link":
			insideLink = decodeEntry(entry)
		case "escape":
			escapeLink = decodeEntry(entry)
		}
	}
	for _, entry := range meta(t, root, "src", "list").Entries {
		if entry.Name == "a.txt" {
			sourceFile = decodeEntry(entry)
		}
	}
	var stats struct {
		Size    uint64  `json:"size"`
		MtimeMs float64 `json:"mtimeMs"`
	}
	must(t, json.Unmarshal(sourceFile["stats"], &stats))
	if stats.Size != 5 || stats.MtimeMs == 0 || !bytes.Equal(sourceFile["stats"], insideLink["stats"]) {
		t.Fatalf("list did not supply stat data for file and confined link: %s %s", sourceFile["stats"], insideLink["stats"])
	}
	if string(escapeLink["stats"]) != "null" {
		t.Fatalf("list disclosed or omitted the refusal of outside stat data: %s", escapeLink["stats"])
	}
	if got := meta(t, root, "src/a.txt", "lstat"); got.Status != "entry" || got.Entry.Kind != "file" || got.Entry.Size != 5 || got.Entry.Ino == 0 {
		t.Fatalf("lstat: %+v", got)
	}
	if got := meta(t, root, "inside-link", "lstat"); got.Entry == nil || got.Entry.Kind != "symlink" {
		t.Fatalf("lstat of a link must not follow: %+v", got)
	}
	if got := meta(t, root, "inside-link", "stat"); got.Status != "entry" || got.Entry.Kind != "file" || *got.Path != "src/a.txt" {
		t.Fatalf("stat follows an inside link: %+v", got)
	}
	if got := meta(t, root, "abs-inside/a.txt", "realpath"); got.Status != "path" || *got.Path != "src/a.txt" {
		t.Fatalf("absolute link into the root: %+v", got)
	}
	for _, escape := range []string{"escape", "etc/passwd"} {
		if got := meta(t, root, escape, "stat"); got.Status != "error" || got.Code != "workspace_root_unsafe" {
			t.Fatalf("%s must be refused: %+v", escape, got)
		}
	}
	if got := meta(t, root, "loop", "realpath"); got.Code != "symlink_loop" {
		t.Fatalf("loop: %+v", got)
	}
	if got := meta(t, root, "inside-link", "readlink"); got.Status != "link" || *got.Target != "src/a.txt" {
		t.Fatalf("readlink: %+v", got)
	}
	if got := meta(t, root, "src/none", "lstat"); got.Status != "missing" {
		t.Fatalf("missing: %+v", got)
	}
	if got := meta(t, root, "../ws/src", "list"); got.Code != "workspace_root_unsafe" {
		t.Fatalf("dot-dot request: %+v", got)
	}
}

func TestWorkspaceTargetWritePublishesWithExpectationsAndNeverThroughLinks(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "ws")
	must(t, os.MkdirAll(root, 0o755))
	must(t, os.Symlink(parent, filepath.Join(root, "out")))

	if got := write(t, root, map[string]any{"op": "put", "relativePath": "new.txt", "expect": "absent"}, "one"); got.Status != "written" {
		t.Fatalf("create: %+v", got)
	}
	if got := write(t, root, map[string]any{"op": "put", "relativePath": "new.txt", "expect": "absent"}, "two"); got.Status != "exists" {
		t.Fatalf("create over existing: %+v", got)
	}
	sum := sha256.Sum256([]byte("one"))
	if got := write(t, root, map[string]any{"op": "put", "relativePath": "new.txt", "expect": strings.Repeat("0", 64)}, "two"); got.Status != "changed" || got.Sha256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("stale expectation: %+v", got)
	}
	if got := write(t, root, map[string]any{"op": "put", "relativePath": "new.txt", "expect": hex.EncodeToString(sum[:])}, "two"); got.Status != "written" {
		t.Fatalf("replace: %+v", got)
	}
	if content, _ := os.ReadFile(filepath.Join(root, "new.txt")); string(content) != "two" {
		t.Fatalf("content %q", content)
	}
	if got := write(t, root, map[string]any{"op": "put", "relativePath": "out/planted", "expect": "any"}, "x"); got.Status != "error" {
		t.Fatalf("write through a link must be refused: %+v", got)
	}
	if _, err := os.Stat(filepath.Join(parent, "planted")); err == nil {
		t.Fatal("a file was written outside the root")
	}
	if got := write(t, root, map[string]any{"op": "mkdir", "relativePath": "a/b/c", "recursive": true}, ""); got.Status != "done" {
		t.Fatalf("mkdir -p: %+v", got)
	}
	if got := write(t, root, map[string]any{"op": "rename", "relativePath": "new.txt", "toRelativePath": "a/b/moved.txt"}, ""); got.Status != "done" {
		t.Fatalf("rename: %+v", got)
	}
	if content, _ := os.ReadFile(filepath.Join(root, "a", "b", "moved.txt")); string(content) != "two" {
		t.Fatalf("moved content %q", content)
	}
	entries, _ := os.ReadDir(root)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".happier-write-") {
			t.Fatalf("staged file left behind: %s", entry.Name())
		}
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestWorkspaceTargetMetaCaptureLeafAtomicFileSymlinkDirectoryMissingAndEscape(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "ws")
	must(t, os.MkdirAll(filepath.Join(root, "src"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "src", "exec.sh"), []byte("#!/bin/sh\necho hi\n"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "src", "empty.txt"), []byte(""), 0o644))
	must(t, os.WriteFile(filepath.Join(parent, "secret"), []byte("outside"), 0o600))
	must(t, os.Symlink("../secret", filepath.Join(root, "escape-link")))
	must(t, os.Symlink(parent, filepath.Join(root, "dir-link")))

	// Regular executable file
	fileRes := meta(t, root, "src/exec.sh", "capture-leaf")
	if fileRes.Status != "leaf" || fileRes.Entry == nil || fileRes.Entry.Kind != "file" {
		t.Fatalf("capture-leaf regular file: %+v", fileRes)
	}
	if fileRes.Entry.Mode&0o111 == 0 {
		t.Fatalf("expected executable mode bit preserved: %o", fileRes.Entry.Mode)
	}
	expectedBytes := []byte("#!/bin/sh\necho hi\n")
	sum := sha1.Sum(expectedBytes)
	if fileRes.Digest != hex.EncodeToString(sum[:]) {
		t.Fatalf("digest mismatch: got %q want %q", fileRes.Digest, hex.EncodeToString(sum[:]))
	}
	if fileRes.ContentBase64 == nil {
		t.Fatalf("expected contentBase64 for regular file: %+v", fileRes)
	}
	decoded, err := base64.StdEncoding.DecodeString(*fileRes.ContentBase64)
	must(t, err)
	if !bytes.Equal(decoded, expectedBytes) {
		t.Fatalf("decoded content mismatch: %q", string(decoded))
	}

	// Empty file retains empty string ContentBase64
	emptyRes := meta(t, root, "src/empty.txt", "capture-leaf")
	if emptyRes.Status != "leaf" || emptyRes.ContentBase64 == nil || *emptyRes.ContentBase64 != "" {
		t.Fatalf("capture-leaf empty file: %+v", emptyRes)
	}

	// Symlink (never followed; returns raw target and link entry metadata)
	linkRes := meta(t, root, "escape-link", "capture-leaf")
	if linkRes.Status != "link" || linkRes.Entry == nil || linkRes.Entry.Kind != "symlink" || linkRes.Target == nil || *linkRes.Target != "../secret" {
		t.Fatalf("capture-leaf symlink: %+v", linkRes)
	}

	// Directory
	dirRes := meta(t, root, "src", "capture-leaf")
	if dirRes.Status != "entry" || dirRes.Entry == nil || dirRes.Entry.Kind != "directory" {
		t.Fatalf("capture-leaf directory: %+v", dirRes)
	}

	// Missing (and under missing ancestor)
	if missRes := meta(t, root, "no/such/file.txt", "capture-leaf"); missRes.Status != "missing" {
		t.Fatalf("capture-leaf missing: %+v", missRes)
	}

	// Traversal through symlink ancestor is refused (O_NOFOLLOW)
	if escRes := meta(t, root, "dir-link/secret", "capture-leaf"); escRes.Status != "error" || escRes.Code != "workspace_root_unsafe" {
		t.Fatalf("capture-leaf symlink ancestor escape must fail closed: %+v", escRes)
	}
}

func TestWorkspaceTargetMetaAccessExecutable(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "ws")
	must(t, os.MkdirAll(filepath.Join(root, "sub"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "run.sh"), []byte("#!/bin/sh\n"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "plain.txt"), []byte("no exec\n"), 0o644))
	must(t, os.Symlink("run.sh", filepath.Join(root, "run-link")))
	must(t, os.Symlink("/bin/sh", filepath.Join(root, "escape-exec")))

	if got := meta(t, root, "run.sh", "access-executable"); got.Status != "done" {
		t.Fatalf("executable file should pass: %+v", got)
	}
	if got := meta(t, root, "plain.txt", "access-executable"); got.Status != "error" || got.Code != "EACCES" {
		t.Fatalf("non-executable file should return EACCES: %+v", got)
	}
	if got := meta(t, root, "run-link", "access-executable"); got.Status != "done" {
		t.Fatalf("confined symlink to executable should pass: %+v", got)
	}
	if got := meta(t, root, "", "access-executable"); got.Status != "done" {
		t.Fatalf("root directory should be searchable/executable: %+v", got)
	}
	if got := meta(t, root, "sub", "access-executable"); got.Status != "done" {
		t.Fatalf("subdirectory should be searchable/executable: %+v", got)
	}
	if got := meta(t, root, "missing.sh", "access-executable"); got.Status != "missing" {
		t.Fatalf("missing file should report missing: %+v", got)
	}
	if got := meta(t, root, "escape-exec", "access-executable"); got.Status != "error" || got.Code != "workspace_root_unsafe" {
		t.Fatalf("escaping symlink must be refused: %+v", got)
	}
}

func TestWorkspaceTargetWriteCopyExclusiveOpenExclusiveSetTimesAndMkdir(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "src.sh"), []byte("echo hi\n"), 0o755))

	// copy-exclusive
	if got := write(t, root, map[string]any{"op": "copy-exclusive", "relativePath": "src.sh", "toRelativePath": "dst.sh"}, ""); got.Status != "done" {
		t.Fatalf("copy-exclusive create: %+v", got)
	}
	if got := write(t, root, map[string]any{"op": "copy-exclusive", "relativePath": "src.sh", "toRelativePath": "dst.sh"}, ""); got.Status != "exists" {
		t.Fatalf("copy-exclusive over existing must return exists: %+v", got)
	}
	info, err := os.Lstat(filepath.Join(root, "dst.sh"))
	must(t, err)
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("copy-exclusive mode mismatch: %o", info.Mode().Perm())
	}

	// set-times
	if got := write(t, root, map[string]any{"op": "set-times", "relativePath": "dst.sh", "atimeMs": int64(1700000000000), "mtimeMs": int64(1700000005000)}, ""); got.Status != "done" {
		t.Fatalf("set-times: %+v", got)
	}
	statRes := meta(t, root, "dst.sh", "lstat")
	if statRes.Status != "entry" || statRes.Entry == nil || int64(statRes.Entry.MtimeMs) != 1700000005000 {
		t.Fatalf("set-times did not persist mtimeMs: %+v", statRes)
	}

	// mkdir non-recursive existing -> exists
	if got := write(t, root, map[string]any{"op": "mkdir", "relativePath": "single", "recursive": false}, ""); got.Status != "done" {
		t.Fatalf("mkdir single: %+v", got)
	}
	if got := write(t, root, map[string]any{"op": "mkdir", "relativePath": "single", "recursive": false}, ""); got.Status != "exists" {
		t.Fatalf("mkdir existing non-recursive: %+v", got)
	}

	// standalone open-exclusive 2-step
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	done := make(chan error, 1)
	go func() {
		err := workspaceConfinedWriteCommand(nil, inR, outW)
		_ = outW.Close()
		_ = inR.Close()
		done <- err
	}()
	reqLine, _ := json.Marshal(map[string]any{"v": 1, "rootPath": root, "relativePath": "excl.bin", "op": "open-exclusive"})
	_, err = inW.Write(append(reqLine, '\n'))
	must(t, err)
	reader := bufio.NewReader(outR)
	line1, err := reader.ReadBytes('\n')
	must(t, err)
	var opened workspaceTargetResult
	must(t, json.Unmarshal(line1, &opened))
	if opened.Status != "opened" || opened.Entry == nil {
		t.Fatalf("open-exclusive step 1: %+v", opened)
	}
	finishLine, _ := json.Marshal(map[string]any{"relativePath": "src.sh", "mode": 0o640})
	_, err = inW.Write(append(finishLine, '\n'))
	must(t, err)
	_ = inW.Close()
	line2, err := reader.ReadBytes('\n')
	must(t, err)
	var finished workspaceTargetResult
	must(t, json.Unmarshal(line2, &finished))
	if finished.Status != "done" {
		t.Fatalf("open-exclusive step 2: %+v", finished)
	}
	must(t, <-done)
	exclBytes, err := os.ReadFile(filepath.Join(root, "excl.bin"))
	must(t, err)
	if string(exclBytes) != "echo hi\n" {
		t.Fatalf("open-exclusive bytes mismatch: %q", string(exclBytes))
	}
	if got := write(t, root, map[string]any{"op": "open-exclusive", "relativePath": "excl.bin"}, ""); got.Status != "exists" {
		t.Fatalf("open-exclusive on existing must return exists: %+v", got)
	}
}

func TestWorkspaceTargetSecurityNegativeCasesAndFifo(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "ws")
	must(t, os.MkdirAll(filepath.Join(root, "sub"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "file.txt"), []byte("ok"), 0o644))
	must(t, os.WriteFile(filepath.Join(parent, "outside.txt"), []byte("secret"), 0o600))
	must(t, os.Symlink(parent, filepath.Join(root, "dir-link")))
	must(t, os.Symlink("../outside.txt", filepath.Join(root, "leaf-link")))
	fifoPath := filepath.Join(root, "pipe.fifo")
	must(t, unix.Mkfifo(fifoPath, 0o600))

	// Invalid path shapes must fail closed with exact typed refusals
	for _, tc := range []struct {
		path      string
		writeCode string
	}{
		{"../outside.txt", "workspace_root_unsafe"},
		{"sub/../../outside.txt", "workspace_root_unsafe"},
		{"a\x00b", "workspace_root_unsafe"},
		{"/etc/hosts", "workspace_root_unsafe"},
		{"file.txt/child", "not_directory"},
		{"dir-link/outside.txt", "not_directory"},
	} {
		for _, op := range []string{"lstat", "stat", "realpath", "list", "access-executable", "capture-leaf"} {
			if got := meta(t, root, tc.path, op); got.Status != "error" || got.Code != "workspace_root_unsafe" {
				t.Fatalf("meta(%q, %q) must refuse with workspace_root_unsafe: %+v", tc.path, op, got)
			}
		}
		if got := write(t, root, map[string]any{"op": "put", "relativePath": tc.path, "expect": "any"}, "x"); got.Status != "error" || got.Code != tc.writeCode {
			t.Fatalf("put(%q) must refuse with %s: %+v", tc.path, tc.writeCode, got)
		}
		if got := write(t, root, map[string]any{"op": "mkdir", "relativePath": tc.path, "recursive": true}, ""); got.Status != "error" || got.Code != tc.writeCode {
			t.Fatalf("mkdir(%q) must refuse with %s: %+v", tc.path, tc.writeCode, got)
		}
		if got := write(t, root, map[string]any{"op": "rmdir", "relativePath": tc.path}, ""); got.Status != "error" || got.Code != tc.writeCode {
			t.Fatalf("rmdir(%q) must refuse with %s: %+v", tc.path, tc.writeCode, got)
		}
		if got := write(t, root, map[string]any{"op": "set-times", "relativePath": tc.path, "atimeMs": int64(1), "mtimeMs": int64(1)}, ""); got.Status != "error" || got.Code != tc.writeCode {
			t.Fatalf("set-times(%q) must refuse with %s: %+v", tc.path, tc.writeCode, got)
		}
	}

	// Leaf symlink escape refused on stat/realpath/access-executable
	for _, op := range []string{"stat", "realpath", "access-executable"} {
		if got := meta(t, root, "leaf-link", op); got.Status != "error" || got.Code != "workspace_root_unsafe" {
			t.Fatalf("meta(leaf-link, %q) must refuse: %+v", op, got)
		}
	}

	// FIFO: list reports kind "other" with null stats and never blocks; direct open fails closed without blocking.
	listed := meta(t, root, "", "list")
	if listed.Status != "entries" {
		t.Fatalf("list with fifo: %+v", listed)
	}
	foundFifo := false
	for _, entry := range listed.Entries {
		if entry.Name == "pipe.fifo" {
			foundFifo = true
			if entry.Kind != "other" || entry.Stats != nil {
				t.Fatalf("fifo list entry must be kind=other stats=nil: %+v", entry)
			}
		}
	}
	if !foundFifo {
		t.Fatalf("fifo missing from list: %+v", listed.Entries)
	}
	if got := meta(t, root, "pipe.fifo", "lstat"); got.Status != "error" || got.Code != "workspace_root_unsafe" {
		t.Fatalf("lstat fifo must fail closed without blocking: %+v", got)
	}
	if got := write(t, root, map[string]any{"op": "put", "relativePath": "pipe.fifo", "expect": "any"}, "x"); got.Status != "error" || got.Code != "workspace_file_unsupported" {
		t.Fatalf("put over fifo must fail closed without blocking: %+v", got)
	}
}

func TestWorkspaceTargetRenamePublishNoReplaceProtectsConcurrentCreate(t *testing.T) {
	root := t.TempDir()
	must(t, os.WriteFile(filepath.Join(root, "target.txt"), []byte("existing-owner"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, ".staged"), []byte("raced-overwrite"), 0o644))

	dirfd, err := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	must(t, err)
	defer unix.Close(dirfd)

	// exists=false uses RENAME_NOREPLACE (Linux) / RENAME_EXCL (Darwin) and must refuse to clobber target.txt.
	err = workspaceTargetRenamePublish(dirfd, ".staged", "target.txt", false)
	if err != unix.EEXIST {
		t.Fatalf("expected EEXIST on no-replace publish over existing file, got %v", err)
	}
	content, readErr := os.ReadFile(filepath.Join(root, "target.txt"))
	must(t, readErr)
	if string(content) != "existing-owner" {
		t.Fatalf("existing target was clobbered: %q", string(content))
	}

	// exists=true atomically replaces target.txt with .staged.
	must(t, workspaceTargetRenamePublish(dirfd, ".staged", "target.txt", true))
	content, readErr = os.ReadFile(filepath.Join(root, "target.txt"))
	must(t, readErr)
	if string(content) != "raced-overwrite" {
		t.Fatalf("replace publish did not install staged bytes: %q", string(content))
	}
}
