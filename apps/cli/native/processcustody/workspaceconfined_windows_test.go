//go:build windows

package main

import (
	"bufio"
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestWindowsWorkspaceConfinedRelativePathPreservesExactComponents(t *testing.T) {
	components, domainErr := validateWorkspaceConfinedRelativePath(` nested\ note.txt `)
	if domainErr != nil {
		t.Fatalf("exact Windows path rejected: %v", domainErr)
	}
	if len(components) != 2 || components[0] != " nested" || components[1] != " note.txt " {
		t.Fatalf("path components were normalized: %#v", components)
	}
}

func TestWindowsWorkspaceConfinedDirectoryNameRequiresLosslessUTF16(t *testing.T) {
	for _, raw := range [][]uint16{{0xd800}, {0xd801}} {
		if name, err := decodeWorkspaceConfinedWindowsDirectoryName(raw); err == nil {
			t.Fatalf("unpaired surrogate produced an authoritative name %q", name)
		}
	}
	valid := []uint16{'c', 'a', 'f', 0x00e9, 0xd83d, 0xde00}
	if name, err := decodeWorkspaceConfinedWindowsDirectoryName(valid); err != nil || name != "café😀" {
		t.Fatalf("valid Unicode name changed: %q %v", name, err)
	}
	if name, err := decodeWorkspaceConfinedWindowsDirectoryName([]uint16{0xfffd}); err != nil || name != "�" {
		t.Fatalf("literal replacement character changed: %q %v", name, err)
	}
}

func beginWorkspaceConfinedExchange(t *testing.T, command func([]string, io.Reader, io.Writer) error, request any) (*bufio.Reader, *io.PipeWriter, <-chan error) {
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

func commitWorkspaceConfinedExchange(t *testing.T, reader *bufio.Reader, input *io.PipeWriter, done <-chan error) map[string]any {
	t.Helper()
	if _, err := io.WriteString(input, "{\"v\":1,\"decision\":\"commit\"}\n"); err != nil {
		t.Fatalf("write commit: %v", err)
	}
	_ = input.Close()
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

func TestWorkspaceConfinedReadHoldsAndReadsTheExactFile(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "preview.txt")
	if err := os.WriteFile(path, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	digestBytes := sha1.Sum([]byte("hello"))
	digest := hex.EncodeToString(digestBytes[:])
	reader, input, done := beginWorkspaceConfinedExchange(t, workspaceConfinedReadCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "preview.txt", "maxBytes": 32, "expectedDigest": digest,
	})
	result := commitWorkspaceConfinedExchange(t, reader, input, done)
	if result["status"] != "content" || result["digest"] != digest || result["contentBase64"] != base64.StdEncoding.EncodeToString([]byte("hello")) {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestWorkspaceConfinedReadRefreshesSizeAfterPreparedFileShrinks(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "preview.txt")
	content := []byte("small")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	prepared, domainErr := prepareWorkspaceConfinedRead(workspaceConfinedReadRequest{
		rootPath: root, relativePath: "preview.txt", maxBytes: 32,
	})
	if domainErr != nil {
		t.Fatalf("prepare read: %v", domainErr)
	}
	operation := prepared.(*workspaceConfinedReadOperation)
	defer operation.close()

	// The retained handle denies new writers. Model a large size cached at prepare
	// time while the same native object now reports the smaller current size.
	finalIndex := len(operation.path.handles) - 1
	operation.path.handles[finalIndex].info.FileSizeHigh = 0
	operation.path.handles[finalIndex].info.FileSizeLow = 64

	result := operation.commit()
	digestBytes := sha1.Sum(content)
	if result.Status != "content" || result.Size == nil || uint64(*result.Size) != uint64(len(content)) || result.Digest != hex.EncodeToString(digestBytes[:]) {
		t.Fatalf("unexpected refreshed read result: %#v", result)
	}
}

func TestWorkspaceConfinedReadDetectsReplacementAfterPrepared(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "preview.txt")
	if err := os.WriteFile(path, []byte("before"), 0o600); err != nil {
		t.Fatal(err)
	}
	reader, input, done := beginWorkspaceConfinedExchange(t, workspaceConfinedReadCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "preview.txt", "maxBytes": 32,
	})
	if err := os.Rename(path, path+".old"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	result := commitWorkspaceConfinedExchange(t, reader, input, done)
	if result["status"] != "error" || result["code"] != "conflict_changed" {
		t.Fatalf("replacement did not fail closed: %#v", result)
	}
}

func TestWorkspaceConfinedReadRejectsFinalSymlinkWithoutDisclosingTarget(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("outside-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "preview.txt")); err != nil {
		t.Fatalf("create required Windows symlink fixture: %v", err)
	}
	reader, input, done := beginWorkspaceConfinedExchange(t, workspaceConfinedReadCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "preview.txt", "maxBytes": 64,
	})
	result := commitWorkspaceConfinedExchange(t, reader, input, done)
	if result["status"] != "error" || result["code"] != "workspace_file_unsupported" {
		t.Fatalf("symlink preview did not fail closed: %#v", result)
	}
	if _, present := result["contentBase64"]; present {
		t.Fatalf("symlink preview disclosed target content: %#v", result)
	}
}

func TestWorkspaceConfinedReadRejectsAncestorReplacementAfterPrepared(t *testing.T) {
	root := t.TempDir()
	ancestor := filepath.Join(root, "ancestor")
	if err := os.Mkdir(ancestor, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ancestor, "preview.txt"), []byte("held-original"), 0o600); err != nil {
		t.Fatal(err)
	}
	reader, input, done := beginWorkspaceConfinedExchange(t, workspaceConfinedReadCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": `ancestor\preview.txt`, "maxBytes": 64,
	})
	originalAncestor := filepath.Join(root, "ancestor-original")
	if err := os.Rename(ancestor, originalAncestor); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(ancestor, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ancestor, "preview.txt"), []byte("replacement-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	result := commitWorkspaceConfinedExchange(t, reader, input, done)
	if result["status"] != "error" || result["code"] != "conflict_changed" {
		t.Fatalf("ancestor replacement did not fail closed: %#v", result)
	}
	if _, present := result["contentBase64"]; present {
		t.Fatalf("ancestor replacement disclosed content: %#v", result)
	}
	for path, want := range map[string]string{
		filepath.Join(originalAncestor, "preview.txt"): "held-original",
		filepath.Join(ancestor, "preview.txt"):         "replacement-secret",
	} {
		content, err := os.ReadFile(path)
		if err != nil || string(content) != want {
			t.Fatalf("path %q changed: content=%q err=%v", path, content, err)
		}
	}
}

func TestWorkspaceConfinedDeleteAbortDoesNotMutate(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "loser.txt")
	if err := os.WriteFile(path, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	digestBytes := sha1.Sum([]byte("keep"))
	reader, input, done := beginWorkspaceConfinedExchange(t, workspaceConfinedDeleteCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "loser.txt", "expectedKind": "file", "expectedDigest": hex.EncodeToString(digestBytes[:]),
	})
	_ = reader
	if _, err := io.WriteString(input, "{\"v\":1,\"decision\":\"abort\"}\n"); err != nil {
		t.Fatal(err)
	}
	_ = input.Close()
	if err := <-done; err != nil {
		t.Fatalf("abort command failed: %v", err)
	}
	if content, err := os.ReadFile(path); err != nil || string(content) != "keep" {
		t.Fatalf("abort mutated file: content=%q err=%v", content, err)
	}
}

func TestWorkspaceConfinedDeleteRejectsFinalReplacementAfterPrepared(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "loser.txt")
	originalContent := []byte("held-original")
	if err := os.WriteFile(path, originalContent, 0o600); err != nil {
		t.Fatal(err)
	}
	digestBytes := sha1.Sum(originalContent)
	reader, input, done := beginWorkspaceConfinedExchange(t, workspaceConfinedDeleteCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "loser.txt", "expectedKind": "file", "expectedDigest": hex.EncodeToString(digestBytes[:]),
	})
	originalPath := path + ".original"
	if err := os.Rename(path, originalPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("replacement"), 0o600); err != nil {
		t.Fatal(err)
	}
	result := commitWorkspaceConfinedExchange(t, reader, input, done)
	if result["status"] != "error" || result["code"] != "conflict_changed" {
		t.Fatalf("delete replacement did not fail closed: %#v", result)
	}
	for checkPath, want := range map[string]string{originalPath: "held-original", path: "replacement"} {
		content, err := os.ReadFile(checkPath)
		if err != nil || string(content) != want {
			t.Fatalf("path %q changed: content=%q err=%v", checkPath, content, err)
		}
	}
}

func TestWorkspaceConfinedReadRefusesAnExistingWriter(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "active.txt")
	if err := os.WriteFile(path, []byte("active"), 0o600); err != nil {
		t.Fatal(err)
	}
	writer, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	request, err := json.Marshal(map[string]any{"v": 1, "rootPath": root, "relativePath": "active.txt", "maxBytes": 64})
	if err != nil {
		t.Fatal(err)
	}
	var output strings.Builder
	if err := workspaceConfinedReadCommand(nil, strings.NewReader(string(request)+"\n"), &output); err != nil {
		t.Fatalf("command transport failed: %v", err)
	}
	if strings.Contains(output.String(), "workspace-confined-prepared") || !strings.Contains(output.String(), `"status":"error"`) {
		t.Fatalf("existing writer was not refused before prepare: %s", output.String())
	}
}

func TestWorkspaceConfinedDeleteRejectsAncestorJunctionReplacementAfterPrepared(t *testing.T) {
	root := t.TempDir()
	ancestor := filepath.Join(root, "ancestor")
	if err := os.Mkdir(ancestor, 0o700); err != nil {
		t.Fatal(err)
	}
	originalContent := []byte("held-original")
	if err := os.WriteFile(filepath.Join(ancestor, "loser.txt"), originalContent, 0o600); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	outsidePath := filepath.Join(outside, "loser.txt")
	if err := os.WriteFile(outsidePath, []byte("outside-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	digestBytes := sha1.Sum(originalContent)
	reader, input, done := beginWorkspaceConfinedExchange(t, workspaceConfinedDeleteCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": `ancestor\loser.txt`, "expectedKind": "file", "expectedDigest": hex.EncodeToString(digestBytes[:]),
	})
	originalAncestor := filepath.Join(root, "ancestor-original")
	if err := os.Rename(ancestor, originalAncestor); err != nil {
		t.Fatal(err)
	}
	if output, err := exec.Command("cmd", "/c", "mklink", "/J", ancestor, outside).CombinedOutput(); err != nil {
		t.Fatalf("create replacement junction: %v: %s", err, output)
	}
	result := commitWorkspaceConfinedExchange(t, reader, input, done)
	if result["status"] != "error" || result["code"] != "conflict_changed" {
		t.Fatalf("ancestor junction replacement did not fail closed: %#v", result)
	}
	for path, want := range map[string]string{
		filepath.Join(originalAncestor, "loser.txt"): "held-original",
		outsidePath: "outside-secret",
	} {
		content, err := os.ReadFile(path)
		if err != nil || string(content) != want {
			t.Fatalf("path %q changed: content=%q err=%v", path, content, err)
		}
	}
}

func TestWorkspaceConfinedDeleteRecursesWithoutFollowingReparsePoints(t *testing.T) {
	root := t.TempDir()
	loser := filepath.Join(root, "loser")
	outside := t.TempDir()
	outsideFile := filepath.Join(outside, "keep.txt")
	outsideContent := []byte("keep outside")
	if err := os.WriteFile(outsideFile, outsideContent, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(loser, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(loser, "nested", "file.txt"), []byte("delete"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(loser, "nested", "outside-link")); err != nil {
		t.Fatalf("create reparse child fixture: %v", err)
	}
	reader, input, done := beginWorkspaceConfinedExchange(t, workspaceConfinedDeleteCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "loser", "expectedKind": "directory",
	})
	result := commitWorkspaceConfinedExchange(t, reader, input, done)
	if result["status"] != "deleted" {
		t.Fatalf("unexpected delete result: %#v", result)
	}
	if _, err := os.Lstat(loser); !os.IsNotExist(err) {
		t.Fatalf("loser still exists: %v", err)
	}
	got, err := os.ReadFile(outsideFile)
	if err != nil {
		t.Fatalf("read outside file after delete: %v", err)
	}
	if !bytes.Equal(got, outsideContent) {
		t.Fatalf("outside file changed: got %q", got)
	}
}

func TestWorkspaceConfinedDeleteRemovesReadonlyFile(t *testing.T) {
	root := t.TempDir()
	loser := filepath.Join(root, "readonly.txt")
	content := []byte("readonly")
	if err := os.WriteFile(loser, content, 0o444); err != nil {
		t.Fatal(err)
	}
	digestBytes := sha1.Sum(content)
	reader, input, done := beginWorkspaceConfinedExchange(t, workspaceConfinedDeleteCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "readonly.txt", "expectedKind": "file", "expectedDigest": hex.EncodeToString(digestBytes[:]),
	})
	result := commitWorkspaceConfinedExchange(t, reader, input, done)
	if result["status"] != "deleted" {
		t.Fatalf("unexpected delete result: %#v", result)
	}
	if _, err := os.Lstat(loser); !os.IsNotExist(err) {
		t.Fatalf("readonly loser still exists: %v", err)
	}
}

func TestWorkspaceConfinedDeleteRejectsRootReplacementAfterPrepared(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "root")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	loser := filepath.Join(root, "loser")
	if err := os.Mkdir(loser, 0o700); err != nil {
		t.Fatal(err)
	}
	reader, input, done := beginWorkspaceConfinedExchange(t, workspaceConfinedDeleteCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "loser", "expectedKind": "directory",
	})
	originalRoot := root + ".original"
	if err := os.Rename(root, originalRoot); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "loser"), 0o700); err != nil {
		t.Fatal(err)
	}
	result := commitWorkspaceConfinedExchange(t, reader, input, done)
	if result["status"] != "error" || result["code"] != "workspace_root_unsafe" {
		t.Fatalf("root replacement did not fail closed: %#v", result)
	}
	if _, err := os.Stat(filepath.Join(originalRoot, "loser")); err != nil {
		t.Fatalf("original loser was mutated: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "loser")); err != nil {
		t.Fatalf("replacement loser was mutated: %v", err)
	}
}

func TestWorkspaceConfinedNTAbsolutePathHandlesExtendedDriveAndUNC(t *testing.T) {
	for _, test := range []struct {
		input string
		want  string
	}{
		{`C:\work`, `\??\C:\work`},
		{`\\?\C:\work`, `\??\C:\work`},
		{`\\server\share\work`, `\??\UNC\server\share\work`},
		{`\\?\UNC\server\share\work`, `\??\UNC\server\share\work`},
	} {
		_, got, domainErr := workspaceConfinedNTAbsolutePath(test.input)
		if domainErr != nil || got != test.want {
			t.Fatalf("convert %q: got %q, error %#v, want %q", test.input, got, domainErr, test.want)
		}
	}
}

func TestWorkspaceConfinedNTAbsolutePathRejectsExtendedDeviceNamespace(t *testing.T) {
	_, _, domainErr := workspaceConfinedNTAbsolutePath(`\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1`)
	if domainErr == nil || domainErr.code != "workspace_root_unsafe" {
		t.Fatalf("extended device namespace did not fail closed: %#v", domainErr)
	}
}

func TestWorkspaceConfinedDeleteMissingIsIdempotentAfterCommit(t *testing.T) {
	root := t.TempDir()
	reader, input, done := beginWorkspaceConfinedExchange(t, workspaceConfinedDeleteCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "absent", "expectedKind": "missing",
	})
	result := commitWorkspaceConfinedExchange(t, reader, input, done)
	if result["status"] != "deleted" {
		t.Fatalf("unexpected delete result: %#v", result)
	}
}

func TestWorkspaceConfinedRejectsUnsafeRelativePaths(t *testing.T) {
	root := t.TempDir()
	for _, relative := range []string{"", ".", "..", `C:\\escape`, `\\server\\share`, `a\\..\\b`, `a:b`, `a\\\\b`, "/absolute"} {
		var output strings.Builder
		request, err := json.Marshal(map[string]any{"v": 1, "rootPath": root, "relativePath": relative, "maxBytes": 1})
		if err != nil {
			t.Fatal(err)
		}
		err = workspaceConfinedReadCommand(nil, strings.NewReader(string(request)+"\n"), &output)
		if err != nil {
			t.Fatalf("command transport failed for %q: %v", relative, err)
		}
		if !strings.Contains(output.String(), `"status":"error"`) || !strings.Contains(output.String(), `"code":"workspace_root_unsafe"`) {
			t.Fatalf("unsafe path %q was not rejected: %s", relative, output.String())
		}
		if strings.Contains(output.String(), "workspace-confined-prepared") {
			t.Fatalf("unsafe path %q reached prepared: %s", relative, output.String())
		}
	}
}

func TestWindowsWorkspaceConfinedObserveCaptureApplyAndRecover(t *testing.T) {
	root := t.TempDir()
	captureDirectory := t.TempDir()
	recoveryDirectory := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "selected"), []byte("selected bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "destination"), 0o700); err != nil {
		t.Fatal(err)
	}

	observeReader, observeInput, observeDone := beginWorkspaceConfinedExchange(t, workspaceConfinedObserveCommand, map[string]any{"v": 1, "rootPath": root, "relativePath": "selected"})
	observed := commitWorkspaceConfinedExchange(t, observeReader, observeInput, observeDone)
	selected := observed["expectation"]
	if observed["status"] != "observed" || selected == nil {
		t.Fatalf("unexpected observation: %#v", observed)
	}

	captureReader, captureInput, captureDone := beginWorkspaceConfinedExchange(t, workspaceConfinedCaptureCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "selected", "expected": selected, "captureDirectory": captureDirectory, "operationId": "native-e2e",
	})
	captured := commitWorkspaceConfinedExchange(t, captureReader, captureInput, captureDone)
	materialPath, ok := captured["materialPath"].(string)
	if captured["status"] != "captured" || !ok {
		t.Fatalf("unexpected capture: %#v", captured)
	}
	destination, err := observeWorkspaceConfinedPrivateMaterial(filepath.Join(root, "destination"))
	if err != nil {
		t.Fatal(err)
	}

	applyReader, applyInput, applyDone := beginWorkspaceConfinedExchange(t, workspaceConfinedApplyCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "destination", "expectedDestination": destination, "selectedExpectation": selected,
		"materialPath": materialPath, "recoveryDirectory": recoveryDirectory, "operationId": "native-e2e",
	})
	applied := commitWorkspaceConfinedExchange(t, applyReader, applyInput, applyDone)
	if applied["status"] != "installed" {
		t.Fatalf("unexpected apply: %#v", applied)
	}
	if content, err := os.ReadFile(filepath.Join(root, "destination")); err != nil || string(content) != "selected bytes" {
		t.Fatalf("selected file was not installed: %q %v", content, err)
	}

	recoverReader, recoverInput, recoverDone := beginWorkspaceConfinedExchange(t, workspaceConfinedRecoverCommand, map[string]any{"v": 1, "rootPath": root, "recoveryDirectory": recoveryDirectory, "operationId": "native-e2e"})
	recovered := commitWorkspaceConfinedExchange(t, recoverReader, recoverInput, recoverDone)
	if recovered["status"] != "settled" {
		t.Fatalf("completed apply left recovery blocked: %#v", recovered)
	}
}

func TestWindowsWorkspaceConfinedObserveMeasuresCurrentNestedRegularFiles(t *testing.T) {
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
		t.Fatalf("create required Windows symlink fixture: %v", err)
	}
	reader, input, done := beginWorkspaceConfinedExchange(t, workspaceConfinedObserveCommand, map[string]any{
		"v": 1, "rootPath": root, "relativePath": "copy", "measureSize": true,
	})
	measured := commitWorkspaceConfinedExchange(t, reader, input, done)
	if measured["status"] != "measured" || measured["sizeBytes"] != float64(21) || measured["expectation"] != nil {
		t.Fatalf("unexpected passive measurement: %#v", measured)
	}
}

func TestWindowsWorkspaceConfinedRecoverRetainsChangedDisplacedEntry(t *testing.T) {
	root := t.TempDir()
	recovery := t.TempDir()
	priorName := ".happier-conflict-resolution-op-prior"
	priorPath := filepath.Join(root, priorName)
	if err := os.WriteFile(priorPath, []byte("reviewed"), 0o600); err != nil {
		t.Fatal(err)
	}
	prior, _ := observeWorkspaceConfinedPrivateMaterial(priorPath)
	if err := os.WriteFile(filepath.Join(root, "entry"), []byte("selected"), 0o600); err != nil {
		t.Fatal(err)
	}
	selected, _ := observeWorkspaceConfinedPrivateMaterial(filepath.Join(root, "entry"))
	held, domainErr := openWorkspaceConfinedHeldPath(root, "entry", true)
	if domainErr != nil {
		t.Fatal(domainErr)
	}
	identity := windowsWorkspaceConfinedIdentity(held.handles[0])
	held.close()
	record := workspaceConfinedRecoveryRecord{V: 1, OperationID: "op", RootPath: root, RootIdentity: identity, RelativePath: "entry", ExpectedDestination: prior, SelectedExpectation: selected, CandidateName: ".happier-conflict-resolution-op-selected", PriorName: priorName}
	if err := workspaceConfinedWriteRecoveryRecord(workspaceConfinedRecoveryRecordPath(recovery, "op"), record); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(priorPath, []byte("unreviewed"), 0o600); err != nil {
		t.Fatal(err)
	}
	reader, input, done := beginWorkspaceConfinedExchange(t, workspaceConfinedRecoverCommand, map[string]any{"v": 1, "rootPath": root, "recoveryDirectory": recovery, "operationId": "op"})
	result := commitWorkspaceConfinedExchange(t, reader, input, done)
	if result["status"] != "recovery_needed" {
		t.Fatalf("changed displaced entry was settled: %#v", result)
	}
	if content, err := os.ReadFile(priorPath); err != nil || string(content) != "unreviewed" {
		t.Fatalf("changed displaced bytes were removed: %q %v", content, err)
	}
}
