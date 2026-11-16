//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProgramFilesKnownFolderIgnoresAmbientDirectory(t *testing.T) {
	t.Setenv("ProgramFiles", filepath.Join(t.TempDir(), "untrusted-policy-root"))
	path, err := windowsProgramFilesPath()
	if err != nil {
		t.Fatal(err)
	}
	if path == os.Getenv("ProgramFiles") || !filepath.IsAbs(path) {
		t.Fatalf("KnownFolder did not return an independent machine directory")
	}
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		t.Fatalf("KnownFolder did not name the native Program Files directory: %v", err)
	}
}
