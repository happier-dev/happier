package main

import (
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

type target struct {
	goos   string
	goarch string
}

type invocation struct {
	args []string
	env  map[string]string
}

func main() {
	var targetName string
	var output string
	flag.StringVar(&targetName, "target", "", "target os-arch")
	flag.StringVar(&output, "output", "", "target executable path")
	flag.Parse()

	if flag.NArg() != 0 {
		exitError(fmt.Errorf("unexpected positional arguments"))
	}
	selected, err := parseTarget(targetName)
	if err != nil {
		exitError(err)
	}
	if strings.TrimSpace(output) == "" {
		exitError(fmt.Errorf("--output is required"))
	}
	output, err = filepath.Abs(output)
	if err != nil {
		exitError(fmt.Errorf("resolve output path: %w", err))
	}
	if err := os.MkdirAll(filepath.Dir(output), 0o755); err != nil {
		exitError(fmt.Errorf("create output directory: %w", err))
	}

	moduleRoot, err := resolveModuleRoot()
	if err != nil {
		exitError(err)
	}
	goCommand, err := exec.LookPath("go")
	if err != nil {
		exitError(fmt.Errorf("Go 1.26.5 toolchain is required: %w", err))
	}
	version := strings.TrimSpace(os.Getenv("HAPPIER_VERSION"))
	if version == "" {
		version = "dev"
	}
	if err := executeBuild(
		selected,
		output,
		version,
		goCommand,
		moduleRoot,
		func(command *exec.Cmd) error {
			command.Stdout = os.Stdout
			command.Stderr = os.Stderr
			return command.Run()
		},
		thirdpartynotices.VerifyFile,
	); err != nil {
		exitError(err)
	}
}

func parseTarget(value string) (target, error) {
	value = strings.TrimSpace(strings.ToLower(value))
	if strings.HasSuffix(value, "-x64") {
		value = strings.TrimSuffix(value, "-x64") + "-amd64"
	}
	parts := strings.Split(value, "-")
	if len(parts) != 2 {
		return target{}, fmt.Errorf("unsupported target %q", value)
	}
	selected := target{goos: parts[0], goarch: parts[1]}
	switch selected.goos {
	case "darwin", "linux", "windows":
	default:
		return target{}, fmt.Errorf("unsupported target %q", value)
	}
	switch selected.goarch {
	case "amd64", "arm64":
	default:
		return target{}, fmt.Errorf("unsupported target %q", value)
	}
	return selected, nil
}

func buildInvocation(selected target, output, version string) invocation {
	return invocation{
		args: []string{
			"build",
			"-trimpath",
			"-buildvcs=false",
			"-ldflags=-s -w -X main.buildVersion=" + version,
			"-o",
			output,
			"./cmd/happier-cliproxyapi-managed",
		},
		env: map[string]string{
			"CGO_ENABLED": "0",
			"GOOS":        selected.goos,
			"GOARCH":      selected.goarch,
		},
	}
}

func executeBuild(
	selected target,
	output string,
	version string,
	goCommand string,
	moduleRoot string,
	runCommand func(*exec.Cmd) error,
	verifyNotices func(thirdpartynotices.Context, string) error,
) error {
	build := buildInvocation(selected, output, version)
	command := exec.Command(goCommand, build.args...)
	command.Dir = moduleRoot
	command.Env = mergeEnvironment(os.Environ(), build.env)
	if err := runCommand(command); err != nil {
		return fmt.Errorf("build managed CLIProxyAPI runtime: %w", err)
	}

	noticePath := filepath.Join(moduleRoot, "licenses", "THIRD-PARTY-NOTICES")
	if err := verifyNotices(thirdpartynotices.Context{
		GoCommand:      goCommand,
		ModuleRoot:     moduleRoot,
		PackagePattern: "./cmd/happier-cliproxyapi-managed",
		BinaryPath:     output,
		BuildEnv:       build.env,
	}, noticePath); err != nil {
		return fmt.Errorf("verify managed CLIProxyAPI third-party notices: %w", err)
	}
	return nil
}

func resolveModuleRoot() (string, error) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		return "", errors.New("resolve managed-runtime build helper path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", "..")), nil
}

func mergeEnvironment(base []string, overrides map[string]string) []string {
	result := make([]string, 0, len(base)+len(overrides))
	for _, entry := range base {
		name, _, found := strings.Cut(entry, "=")
		if found {
			if _, overridden := overrides[name]; overridden {
				continue
			}
		}
		result = append(result, entry)
	}
	for name, value := range overrides {
		result = append(result, name+"="+value)
	}
	return result
}

func exitError(err error) {
	_, _ = fmt.Fprintln(os.Stderr, err)
	os.Exit(2)
}
