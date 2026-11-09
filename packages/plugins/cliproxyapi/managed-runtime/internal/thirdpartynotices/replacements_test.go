package thirdpartynotices

import (
	"archive/zip"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGenerateUsesPublishedReplacementSource(t *testing.T) {
	context := buildReplacementFixture(t, false)

	notice, err := Generate(context)
	if err != nil {
		t.Fatal(err)
	}
	_, modules, err := readBinarySource(context.BinaryPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(modules) != 1 || modules[0].Path != "example.com/notices-selected" || modules[0].Version != "v1.2.3" {
		t.Fatalf("compiled source identities = %#v, want selected replacement only", modules)
	}
	for _, expected := range []string{
		"example.com/notices-selected v1.2.3\n",
		"module checksum: " + modules[0].Sum + "\n",
		"module source: https://pkg.go.dev/example.com/notices-selected@v1.2.3\n",
		"replacement license evidence\n",
	} {
		if !strings.Contains(string(notice), expected) {
			t.Fatalf("generated notice missing replacement source evidence %q", expected)
		}
	}
	if strings.Contains(string(notice), "example.com/notices-original") {
		t.Fatal("notice attributes the compiled replacement to the original module")
	}
}

func TestReplacementReadersRejectLocalSource(t *testing.T) {
	context := buildReplacementFixture(t, true)
	if _, _, err := readBinarySource(context.BinaryPath); err == nil {
		t.Fatal("compiled local replacement accepted without a versioned source identity")
	}
	if _, err := listCompiledModules(context); err == nil {
		t.Fatal("listed local replacement accepted without a versioned source identity")
	}
}

// Build real module metadata through an offline Go proxy so the test exercises
// both build-info and go-list replacement shapes without mocking either reader.
func buildReplacementFixture(t *testing.T, local bool) Context {
	t.Helper()
	root := t.TempDir()
	write := func(path string, content []byte) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, content, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	const selectedPath = "example.com/notices-selected"
	const selectedVersion = "v1.2.3"
	files := map[string]string{
		"go.mod":  "module " + selectedPath + "\n\ngo 1.20\n",
		"dep.go":  "package dependency\n\nconst Value = 42\n",
		"LICENSE": "replacement license evidence\n",
	}
	proxyRoot := filepath.Join(root, "proxy")
	versionRoot := filepath.Join(proxyRoot, selectedPath, "@v")
	write(filepath.Join(versionRoot, selectedVersion+".mod"), []byte(files["go.mod"]))
	write(filepath.Join(versionRoot, selectedVersion+".info"), []byte(`{"Version":"v1.2.3","Time":"2026-01-01T00:00:00Z"}`))
	write(filepath.Join(versionRoot, "list"), []byte(selectedVersion+"\n"))
	archive, err := os.Create(filepath.Join(versionRoot, selectedVersion+".zip"))
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(archive)
	for _, name := range []string{"go.mod", "dep.go", "LICENSE"} {
		entry, err := writer.Create(selectedPath + "@" + selectedVersion + "/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write([]byte(files[name])); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	moduleRoot := filepath.Join(root, "app")
	replacement := selectedPath + " " + selectedVersion
	if local {
		for name, content := range files {
			write(filepath.Join(root, "local", name), []byte(content))
		}
		replacement = "../local"
	}
	write(filepath.Join(moduleRoot, "go.mod"), []byte(fmt.Sprintf(
		"module example.com/notices-app\n\ngo 1.20\n\nrequire example.com/notices-original v1.0.0\nreplace example.com/notices-original => %s\n", replacement,
	)))
	write(filepath.Join(moduleRoot, "main.go"), []byte("package main\n\nimport dep \"example.com/notices-original\"\n\nfunc main() { println(dep.Value) }\n"))
	proxyURL := url.URL{Scheme: "file", Path: "/" + strings.TrimPrefix(filepath.ToSlash(proxyRoot), "/")}
	context := Context{
		GoCommand:      "go",
		ModuleRoot:     moduleRoot,
		PackagePattern: ".",
		BinaryPath:     filepath.Join(root, "app-binary"),
		BuildEnv: map[string]string{
			"GOPROXY": proxyURL.String(),
			"GOSUMDB": "off",
			"GOWORK":  "off",
		},
	}
	command := exec.Command(context.GoCommand, "build", "-mod=mod", "-o", context.BinaryPath, context.PackagePattern)
	command.Dir = context.ModuleRoot
	command.Env = mergeEnvironment(os.Environ(), context.BuildEnv)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build replacement fixture: %v\n%s", err, output)
	}
	return context
}
