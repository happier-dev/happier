//go:build darwin || linux

// Read, delete and observe through the two-phase exchange, on every POSIX
// confinement owner (Darwin and Linux share these contracts).

package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func beginPosixWorkspaceConfinedExchange(t *testing.T, command func([]string, io.Reader, io.Writer) error, request any) (*bufio.Reader, *io.PipeWriter, <-chan error) {
	t.Helper()
	inputReader, inputWriter := io.Pipe()
	outputReader, outputWriter := io.Pipe()
	done := make(chan error, 1)
	go func() {
		done <- command(nil, inputReader, outputWriter)
		_ = outputWriter.Close()
	}()
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("encode request: %v", err)
	}
	if _, err := inputWriter.Write(append(encoded, '\n')); err != nil {
		t.Fatalf("write request: %v", err)
	}
	reader := bufio.NewReader(outputReader)
	prepared, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read prepared line: %v", err)
	}
	if prepared != "{\"v\":1,\"t\":\"workspace-confined-prepared\"}\n" {
		t.Fatalf("unexpected prepared line: %q", prepared)
	}
	return reader, inputWriter, done
}

func decidePosixWorkspaceConfinedExchange(t *testing.T, reader *bufio.Reader, input *io.PipeWriter, done <-chan error, decision string) map[string]any {
	t.Helper()
	if _, err := io.WriteString(input, `{"v":1,"decision":"`+decision+`"}`+"\n"); err != nil {
		t.Fatalf("write decision: %v", err)
	}
	_ = input.Close()
	if decision == "abort" {
		if err := <-done; err != nil {
			t.Fatalf("abort command failed: %v", err)
		}
		return nil
	}
	line, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read result: %v", err)
	}
	var result map[string]any
	if err := json.Unmarshal([]byte(line), &result); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatalf("command failed: %v", err)
	}
	return result
}

func posixWorkspaceConfinedDigest(content []byte) string {
	digest := sha1.Sum(content)
	return hex.EncodeToString(digest[:])
}

func TestPosixWorkspaceConfinedReadHoldsAndReadsExactFile(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	content := []byte("hello from darwin")
	if err := os.WriteFile(filepath.Join(root, "nested", "preview.txt"), content, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := posixWorkspaceConfinedDigest(content)
	reader, input, done := beginPosixWorkspaceConfinedExchange(t, workspaceConfinedReadCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "nested/preview.txt", "maxBytes": 64, "expectedDigest": digest,
	})
	result := decidePosixWorkspaceConfinedExchange(t, reader, input, done, "commit")
	if result["status"] != "content" || result["digest"] != digest || result["contentBase64"] != base64.StdEncoding.EncodeToString(content) {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestPosixWorkspaceConfinedReadRejectsAncestorRenameAndSymlinkReplacement(t *testing.T) {
	root := t.TempDir()
	ancestor := filepath.Join(root, "ancestor")
	if err := os.Mkdir(ancestor, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ancestor, "preview.txt"), []byte("approved"), 0o600); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	secret := []byte("must not escape")
	if err := os.WriteFile(filepath.Join(outside, "preview.txt"), secret, 0o600); err != nil {
		t.Fatal(err)
	}
	reader, input, done := beginPosixWorkspaceConfinedExchange(t, workspaceConfinedReadCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "ancestor/preview.txt", "maxBytes": 64,
	})
	if err := os.Rename(ancestor, filepath.Join(root, "approved-renamed")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, ancestor); err != nil {
		t.Fatal(err)
	}
	result := decidePosixWorkspaceConfinedExchange(t, reader, input, done, "commit")
	if result["status"] != "error" || result["code"] != "conflict_changed" || result["contentBase64"] != nil {
		t.Fatalf("ancestor replacement did not fail closed: %#v", result)
	}
}

func TestPosixWorkspaceConfinedReadRejectsFinalReplacement(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "preview.txt")
	if err := os.WriteFile(path, []byte("approved"), 0o600); err != nil {
		t.Fatal(err)
	}
	reader, input, done := beginPosixWorkspaceConfinedExchange(t, workspaceConfinedReadCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "preview.txt", "maxBytes": 64,
	})
	if err := os.Rename(path, path+".renamed"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	result := decidePosixWorkspaceConfinedExchange(t, reader, input, done, "commit")
	if result["status"] != "error" || result["code"] != "conflict_changed" || result["contentBase64"] != nil {
		t.Fatalf("final replacement did not fail closed: %#v", result)
	}
}

func TestPosixWorkspaceConfinedReadUsesCurrentSizeAfterPrepared(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "preview.txt")
	if err := os.WriteFile(path, []byte("content that starts above the preview limit"), 0o600); err != nil {
		t.Fatal(err)
	}
	reader, input, done := beginPosixWorkspaceConfinedExchange(t, workspaceConfinedReadCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "preview.txt", "maxBytes": 8,
	})
	if err := os.WriteFile(path, []byte("short"), 0o600); err != nil {
		t.Fatal(err)
	}
	result := decidePosixWorkspaceConfinedExchange(t, reader, input, done, "commit")
	if result["status"] != "content" || result["contentBase64"] != base64.StdEncoding.EncodeToString([]byte("short")) {
		t.Fatalf("commit used stale prepared size: %#v", result)
	}
}

func TestPosixWorkspaceConfinedReadRejectsTraversalAndSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	for _, relativePath := range []string{"", ".", "..", "../secret.txt", "nested/../../secret.txt", "/absolute", "a//b"} {
		var output strings.Builder
		request, err := json.Marshal(map[string]any{"v": 1, "rootPath": root, "relativePath": relativePath, "maxBytes": 64})
		if err != nil {
			t.Fatal(err)
		}
		if err := workspaceConfinedReadCommand(nil, strings.NewReader(string(request)+"\n"), &output); err != nil {
			t.Fatalf("command transport failed for %q: %v", relativePath, err)
		}
		if !strings.Contains(output.String(), `"status":"error"`) || !strings.Contains(output.String(), `"code":"workspace_root_unsafe"`) {
			t.Fatalf("unsafe path %q was not rejected: %s", relativePath, output.String())
		}
		if strings.Contains(output.String(), "workspace-confined-prepared") {
			t.Fatalf("unsafe path %q reached prepared: %s", relativePath, output.String())
		}
	}

	var output strings.Builder
	request, err := json.Marshal(map[string]any{"v": 1, "rootPath": root, "relativePath": "escape/secret.txt", "maxBytes": 64})
	if err != nil {
		t.Fatal(err)
	}
	if err := workspaceConfinedReadCommand(nil, strings.NewReader(string(request)+"\n"), &output); err != nil {
		t.Fatalf("symlink escape command failed: %v", err)
	}
	if !strings.Contains(output.String(), `"status":"error"`) || strings.Contains(output.String(), "workspace-confined-prepared") {
		t.Fatalf("intermediate symlink escape was not rejected before prepared: %s", output.String())
	}
}

func TestPosixWorkspaceConfinedDeleteAbortDoesNotMutate(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "loser.txt")
	content := []byte("keep")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	reader, input, done := beginPosixWorkspaceConfinedExchange(t, workspaceConfinedDeleteCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "loser.txt", "expectedKind": "file", "expectedDigest": posixWorkspaceConfinedDigest(content),
	})
	decidePosixWorkspaceConfinedExchange(t, reader, input, done, "abort")
	observed, err := os.ReadFile(path)
	if err != nil || string(observed) != string(content) {
		t.Fatalf("abort mutated file: content=%q err=%v", observed, err)
	}
}

func TestPosixWorkspaceConfinedDeleteRecursesWithoutFollowingSymlinks(t *testing.T) {
	root := t.TempDir()
	loser := filepath.Join(root, "loser")
	if err := os.MkdirAll(filepath.Join(loser, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(loser, "nested", "file.txt"), []byte("delete"), 0o600); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	outsideFile := filepath.Join(outside, "keep.txt")
	if err := os.WriteFile(outsideFile, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(loser, "outside-link")); err != nil {
		t.Fatal(err)
	}
	reader, input, done := beginPosixWorkspaceConfinedExchange(t, workspaceConfinedDeleteCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "loser", "expectedKind": "directory",
	})
	result := decidePosixWorkspaceConfinedExchange(t, reader, input, done, "commit")
	if result["status"] != "deleted" {
		t.Fatalf("unexpected delete result: %#v", result)
	}
	if _, err := os.Lstat(loser); !os.IsNotExist(err) {
		t.Fatalf("loser still exists: %v", err)
	}
	if content, err := os.ReadFile(outsideFile); err != nil || string(content) != "keep" {
		t.Fatalf("recursive delete followed symlink: content=%q err=%v", content, err)
	}
}

func TestPosixWorkspaceConfinedDeleteRejectsAncestorAndFinalReplacement(t *testing.T) {
	t.Run("ancestor", func(t *testing.T) {
		root := t.TempDir()
		ancestor := filepath.Join(root, "ancestor")
		if err := os.Mkdir(ancestor, 0o700); err != nil {
			t.Fatal(err)
		}
		content := []byte("delete")
		if err := os.WriteFile(filepath.Join(ancestor, "loser.txt"), content, 0o600); err != nil {
			t.Fatal(err)
		}
		outside := t.TempDir()
		outsideFile := filepath.Join(outside, "loser.txt")
		if err := os.WriteFile(outsideFile, []byte("outside"), 0o600); err != nil {
			t.Fatal(err)
		}
		reader, input, done := beginPosixWorkspaceConfinedExchange(t, workspaceConfinedDeleteCommand, map[string]any{
			"v": 1, "rootPath": root, "relativePath": "ancestor/loser.txt", "expectedKind": "file", "expectedDigest": posixWorkspaceConfinedDigest(content),
		})
		if err := os.Rename(ancestor, filepath.Join(root, "ancestor-renamed")); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, ancestor); err != nil {
			t.Fatal(err)
		}
		result := decidePosixWorkspaceConfinedExchange(t, reader, input, done, "commit")
		if result["status"] != "error" || result["code"] != "conflict_changed" {
			t.Fatalf("ancestor replacement did not fail closed: %#v", result)
		}
		if content, err := os.ReadFile(outsideFile); err != nil || string(content) != "outside" {
			t.Fatalf("outside replacement was mutated: content=%q err=%v", content, err)
		}
	})

	t.Run("final", func(t *testing.T) {
		root := t.TempDir()
		path := filepath.Join(root, "loser.txt")
		content := []byte("delete")
		if err := os.WriteFile(path, content, 0o600); err != nil {
			t.Fatal(err)
		}
		reader, input, done := beginPosixWorkspaceConfinedExchange(t, workspaceConfinedDeleteCommand, map[string]any{
			"v": 1, "rootPath": root, "relativePath": "loser.txt", "expectedKind": "file", "expectedDigest": posixWorkspaceConfinedDigest(content),
		})
		if err := os.Rename(path, path+".renamed"); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("replacement"), 0o600); err != nil {
			t.Fatal(err)
		}
		result := decidePosixWorkspaceConfinedExchange(t, reader, input, done, "commit")
		if result["status"] != "error" || result["code"] != "conflict_changed" {
			t.Fatalf("final replacement did not fail closed: %#v", result)
		}
		if content, err := os.ReadFile(path); err != nil || string(content) != "replacement" {
			t.Fatalf("replacement was mutated: content=%q err=%v", content, err)
		}
	})
}

func TestPosixWorkspaceConfinedObserveMeasuresRegularFilesWithoutFollowingSymlinks(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "copy", ".cache", "compiler"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "copy", "source"), []byte("copy"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "copy", ".cache", "compiler", "warm"), make([]byte, 17), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "private"), make([]byte, 4096), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "copy", "outside")); err != nil {
		t.Fatal(err)
	}
	reader, input, done := beginPosixWorkspaceConfinedExchange(t, workspaceConfinedObserveCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "copy", "measureSize": true,
	})
	measured := decidePosixWorkspaceConfinedExchange(t, reader, input, done, "commit")
	if measured["status"] != "measured" || measured["sizeBytes"] != float64(21) || measured["expectation"] != nil {
		t.Fatalf("unexpected passive measurement: %#v", measured)
	}
}

func TestPosixWorkspaceConfinedReadOfAMissingAncestorIsMissing(t *testing.T) {
	root := t.TempDir()
	reader, input, done := beginPosixWorkspaceConfinedExchange(t, workspaceConfinedReadCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "absent/dir/file.txt", "maxBytes": 64,
	})
	result := decidePosixWorkspaceConfinedExchange(t, reader, input, done, "commit")
	if result["status"] != "missing" {
		t.Fatalf("missing ancestor was not reported as missing: %#v", result)
	}
}

func TestPosixWorkspaceConfinedObserveThenCaptureCopiesTheExactObservedTree(t *testing.T) {
	root := t.TempDir()
	captureDirectory := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "tree", "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "tree", "nested", "file.txt"), []byte("captured"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../outside", filepath.Join(root, "tree", "link")); err != nil {
		t.Fatal(err)
	}
	reader, input, done := beginPosixWorkspaceConfinedExchange(t, workspaceConfinedObserveCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "tree",
	})
	observed := decidePosixWorkspaceConfinedExchange(t, reader, input, done, "commit")
	expectation, ok := observed["expectation"].(map[string]any)
	if observed["status"] != "observed" || !ok || expectation["kind"] != "directory" || expectation["fingerprint"] == "" {
		t.Fatalf("unexpected observation: %#v", observed)
	}

	reader, input, done = beginPosixWorkspaceConfinedExchange(t, workspaceConfinedCaptureCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "tree", "expected": expectation,
		"captureDirectory": captureDirectory, "operationId": "op-1",
	})
	captured := decidePosixWorkspaceConfinedExchange(t, reader, input, done, "commit")
	materialPath, _ := captured["materialPath"].(string)
	if captured["status"] != "captured" || materialPath == "" {
		t.Fatalf("unexpected capture: %#v", captured)
	}
	content, err := os.ReadFile(filepath.Join(materialPath, "nested", "file.txt"))
	if err != nil || string(content) != "captured" {
		t.Fatalf("captured file differs: %q %v", content, err)
	}
	if target, err := os.Readlink(filepath.Join(materialPath, "link")); err != nil || target != "../outside" {
		t.Fatalf("captured symlink differs: %q %v", target, err)
	}

	// A source that changed after the observation is never captured.
	if err := os.WriteFile(filepath.Join(root, "tree", "nested", "file.txt"), []byte("changed"), 0o640); err != nil {
		t.Fatal(err)
	}
	reader, input, done = beginPosixWorkspaceConfinedExchange(t, workspaceConfinedCaptureCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "tree", "expected": expectation,
		"captureDirectory": captureDirectory, "operationId": "op-2",
	})
	changed := decidePosixWorkspaceConfinedExchange(t, reader, input, done, "commit")
	if changed["status"] != "error" || changed["code"] != "conflict_changed" {
		t.Fatalf("changed source was captured: %#v", changed)
	}
	if _, err := os.Lstat(filepath.Join(captureDirectory, "workspace-entry-op-2")); !os.IsNotExist(err) {
		t.Fatalf("partial capture material remained: %v", err)
	}
}
