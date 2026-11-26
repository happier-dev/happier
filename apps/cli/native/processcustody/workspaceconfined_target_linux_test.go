//go:build linux

package main

import (
	"bytes"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	if bytes, _ := os.ReadFile(filepath.Join(root, "new.txt")); string(bytes) != "two" {
		t.Fatalf("content %q", bytes)
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
	if bytes, _ := os.ReadFile(filepath.Join(root, "a", "b", "moved.txt")); string(bytes) != "two" {
		t.Fatalf("moved content %q", bytes)
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
