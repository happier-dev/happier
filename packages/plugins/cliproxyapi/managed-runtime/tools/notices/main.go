package main

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/happier-dev/happier/packages/plugins/cliproxyapi/managed-runtime/internal/thirdpartynotices"
)

func main() {
	var binaryPath string
	var outputPath string
	var goos string
	var goarch string
	var check bool
	flag.StringVar(&binaryPath, "binary", "", "built managed-runtime executable")
	flag.StringVar(&outputPath, "output", "", "third-party notice file")
	flag.StringVar(&goos, "goos", runtime.GOOS, "built executable GOOS")
	flag.StringVar(&goarch, "goarch", runtime.GOARCH, "built executable GOARCH")
	flag.BoolVar(&check, "check", false, "verify the output instead of replacing it")
	flag.Parse()

	if flag.NArg() != 0 {
		exitError(fmt.Errorf("unexpected positional arguments"))
	}
	if strings.TrimSpace(binaryPath) == "" {
		exitError(fmt.Errorf("--binary is required"))
	}
	moduleRoot, err := resolveModuleRoot()
	if err != nil {
		exitError(err)
	}
	if strings.TrimSpace(outputPath) == "" {
		outputPath = filepath.Join(moduleRoot, "licenses", "THIRD-PARTY-NOTICES")
	}
	goCommand, err := exec.LookPath("go")
	if err != nil {
		exitError(fmt.Errorf("Go toolchain is required: %w", err))
	}
	context := thirdpartynotices.Context{
		GoCommand:      goCommand,
		ModuleRoot:     moduleRoot,
		PackagePattern: "./cmd/happier-cliproxyapi-managed",
		BinaryPath:     binaryPath,
		BuildEnv: map[string]string{
			"CGO_ENABLED": "0",
			"GOOS":        strings.TrimSpace(goos),
			"GOARCH":      strings.TrimSpace(goarch),
		},
	}
	if check {
		if err := thirdpartynotices.VerifyFile(context, outputPath); err != nil {
			exitError(err)
		}
		return
	}
	content, err := thirdpartynotices.Generate(context)
	if err != nil {
		exitError(err)
	}
	if err := writeFileAtomically(outputPath, content); err != nil {
		exitError(err)
	}
}

func resolveModuleRoot() (string, error) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		return "", errors.New("resolve managed-runtime notice helper path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", "..")), nil
}

func writeFileAtomically(path string, content []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create notice directory: %w", err)
	}
	current, err := os.ReadFile(path)
	if err == nil && bytes.Equal(current, content) {
		return nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read existing notice: %w", err)
	}

	temp, err := os.CreateTemp(filepath.Dir(path), ".third-party-notices-*")
	if err != nil {
		return fmt.Errorf("create temporary notice: %w", err)
	}
	tempPath := temp.Name()
	defer func() {
		_ = os.Remove(tempPath)
	}()
	if err := temp.Chmod(0o644); err != nil {
		_ = temp.Close()
		return fmt.Errorf("set notice permissions: %w", err)
	}
	if _, err := temp.Write(content); err != nil {
		_ = temp.Close()
		return fmt.Errorf("write notice: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close notice: %w", err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("replace notice: %w", err)
	}
	return nil
}

func exitError(err error) {
	_, _ = fmt.Fprintln(os.Stderr, err)
	os.Exit(2)
}
