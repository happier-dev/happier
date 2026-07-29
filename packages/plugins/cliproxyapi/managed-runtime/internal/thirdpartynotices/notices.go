package thirdpartynotices

import (
	"bytes"
	"debug/buildinfo"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

const (
	maxEvidenceFileBytes = 1 << 20
	maxNoticeBytes       = 16 << 20
)

type Context struct {
	GoCommand      string
	ModuleRoot     string
	PackagePattern string
	BinaryPath     string
	BuildEnv       map[string]string
}

type moduleIdentity struct {
	Path    string
	Version string
	Sum     string
}

type moduleRecord struct {
	Path    string
	Version string
	Sum     string
	Dir     string
}

type evidenceFile struct {
	Path    string
	Content []byte
}

type moduleEvidence struct {
	Identity moduleIdentity
	Files    []evidenceFile
}

type distributionEvidence struct {
	Version string
	Files   []evidenceFile
}

type goEnvironment struct {
	Version string `json:"GOVERSION"`
	Root    string `json:"GOROOT"`
}

type goListPackage struct {
	ImportPath string        `json:"ImportPath"`
	Dir        string        `json:"Dir"`
	Module     *goListModule `json:"Module"`
}

type goListModule struct {
	Path    string        `json:"Path"`
	Version string        `json:"Version"`
	Sum     string        `json:"Sum"`
	Dir     string        `json:"Dir"`
	Main    bool          `json:"Main"`
	Replace *goListModule `json:"Replace"`
}

type listedModule struct {
	Record      moduleRecord
	PackageDirs []string
}

func Generate(context Context) ([]byte, error) {
	if strings.TrimSpace(context.GoCommand) == "" {
		return nil, errors.New("Go command is required")
	}
	if strings.TrimSpace(context.ModuleRoot) == "" {
		return nil, errors.New("module root is required")
	}
	if strings.TrimSpace(context.PackagePattern) == "" {
		return nil, errors.New("package pattern is required")
	}
	if strings.TrimSpace(context.BinaryPath) == "" {
		return nil, errors.New("binary path is required")
	}

	binaryGoVersion, binaryModules, err := readBinarySource(context.BinaryPath)
	if err != nil {
		return nil, err
	}
	goDistribution, err := collectGoDistributionEvidence(context, binaryGoVersion)
	if err != nil {
		return nil, err
	}
	if err := verifyModuleSources(context); err != nil {
		return nil, err
	}
	listedModules, err := listCompiledModules(context)
	if err != nil {
		return nil, err
	}
	records := make([]moduleRecord, 0, len(listedModules))
	for _, module := range listedModules {
		records = append(records, module.Record)
	}
	if err := validateBinaryModules(binaryModules, records); err != nil {
		return nil, err
	}

	evidence := make([]moduleEvidence, 0, len(listedModules))
	for _, module := range listedModules {
		value, err := collectModuleEvidence(module.Record, module.PackageDirs)
		if err != nil {
			return nil, err
		}
		evidence = append(evidence, value)
	}
	return renderNotice(goDistribution, evidence)
}

func VerifyFile(context Context, expectedPath string) error {
	generated, err := Generate(context)
	if err != nil {
		return err
	}
	expected, err := os.ReadFile(expectedPath)
	if err != nil {
		return fmt.Errorf("read checked-in third-party notices %s: %w", expectedPath, err)
	}
	if !bytes.Equal(generated, expected) {
		return fmt.Errorf(
			"checked-in third-party notices are stale for %s; regenerate %s from the exact built binary",
			filepath.Base(context.BinaryPath),
			expectedPath,
		)
	}
	return nil
}

func readBinarySource(binaryPath string) (string, []moduleIdentity, error) {
	info, err := buildinfo.ReadFile(binaryPath)
	if err != nil {
		return "", nil, fmt.Errorf("read Go build info from %s: %w", binaryPath, err)
	}
	goVersion := strings.TrimSpace(info.GoVersion)
	if goVersion == "" {
		return "", nil, fmt.Errorf("built binary %s has no Go toolchain version", binaryPath)
	}
	modules := make([]moduleIdentity, 0, len(info.Deps))
	seen := make(map[string]struct{}, len(info.Deps))
	for _, dependency := range info.Deps {
		if dependency == nil {
			continue
		}
		if dependency.Replace != nil {
			return "", nil, fmt.Errorf(
				"compiled module %s@%s uses an unsupported replacement",
				dependency.Path,
				dependency.Version,
			)
		}
		identity := moduleIdentity{
			Path:    strings.TrimSpace(dependency.Path),
			Version: strings.TrimSpace(dependency.Version),
			Sum:     strings.TrimSpace(dependency.Sum),
		}
		if identity.Path == "" || identity.Version == "" || identity.Sum == "" {
			return "", nil, fmt.Errorf("compiled module has incomplete source identity: %#v", identity)
		}
		if _, exists := seen[identity.Path]; exists {
			return "", nil, fmt.Errorf("compiled module %s appears more than once", identity.Path)
		}
		seen[identity.Path] = struct{}{}
		modules = append(modules, identity)
	}
	sort.Slice(modules, func(i, j int) bool {
		return modules[i].Path < modules[j].Path
	})
	return goVersion, modules, nil
}

func collectGoDistributionEvidence(context Context, binaryGoVersion string) (distributionEvidence, error) {
	command := exec.Command(context.GoCommand, "env", "-json", "GOVERSION", "GOROOT")
	command.Dir = context.ModuleRoot
	command.Env = mergeEnvironment(os.Environ(), context.BuildEnv)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	output, err := command.Output()
	if err != nil {
		return distributionEvidence{}, fmt.Errorf(
			"inspect Go source toolchain: %w: %s",
			err,
			strings.TrimSpace(stderr.String()),
		)
	}
	var environment goEnvironment
	if err := json.Unmarshal(output, &environment); err != nil {
		return distributionEvidence{}, fmt.Errorf("decode Go source toolchain: %w", err)
	}
	if err := validateGoDistribution(binaryGoVersion, environment); err != nil {
		return distributionEvidence{}, err
	}

	root, err := filepath.Abs(environment.Root)
	if err != nil {
		return distributionEvidence{}, fmt.Errorf("resolve Go source toolchain root: %w", err)
	}
	files := make([]evidenceFile, 0, 2)
	for _, name := range []string{"LICENSE", "PATENTS"} {
		path := filepath.Join(root, name)
		info, err := os.Stat(path)
		if err != nil {
			return distributionEvidence{}, fmt.Errorf(
				"inspect Go %s evidence for %s: %w",
				name,
				binaryGoVersion,
				err,
			)
		}
		if !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > maxEvidenceFileBytes {
			return distributionEvidence{}, fmt.Errorf(
				"Go %s evidence for %s is not a supported regular file",
				name,
				binaryGoVersion,
			)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return distributionEvidence{}, fmt.Errorf(
				"read Go %s evidence for %s: %w",
				name,
				binaryGoVersion,
				err,
			)
		}
		files = append(files, evidenceFile{Path: name, Content: content})
	}
	return distributionEvidence{Version: strings.TrimSpace(binaryGoVersion), Files: files}, nil
}

func validateGoDistribution(binaryGoVersion string, environment goEnvironment) error {
	binaryGoVersion = strings.TrimSpace(binaryGoVersion)
	sourceGoVersion := strings.TrimSpace(environment.Version)
	if binaryGoVersion == "" {
		return errors.New("built binary Go version is required")
	}
	if sourceGoVersion == "" || strings.TrimSpace(environment.Root) == "" {
		return fmt.Errorf("Go source toolchain has incomplete identity: %#v", environment)
	}
	if binaryGoVersion != sourceGoVersion {
		return fmt.Errorf(
			"built binary Go version %s does not match source toolchain %s",
			binaryGoVersion,
			sourceGoVersion,
		)
	}
	return nil
}

func verifyModuleSources(context Context) error {
	command := exec.Command(context.GoCommand, "mod", "verify")
	command.Dir = context.ModuleRoot
	command.Env = mergeEnvironment(os.Environ(), context.BuildEnv)
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("verify Go module source checksums: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func listCompiledModules(context Context) ([]listedModule, error) {
	command := exec.Command(
		context.GoCommand,
		"list",
		"-mod=readonly",
		"-deps",
		"-json",
		context.PackagePattern,
	)
	command.Dir = context.ModuleRoot
	command.Env = mergeEnvironment(os.Environ(), context.BuildEnv)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	output, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("list compiled Go packages: %w: %s", err, strings.TrimSpace(stderr.String()))
	}

	decoder := json.NewDecoder(bytes.NewReader(output))
	modulesByPath := make(map[string]*listedModule)
	for {
		var pkg goListPackage
		err := decoder.Decode(&pkg)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("decode compiled Go packages: %w", err)
		}
		if pkg.Module == nil || pkg.Module.Main {
			continue
		}
		if pkg.Module.Replace != nil {
			return nil, fmt.Errorf(
				"listed module %s@%s uses an unsupported replacement",
				pkg.Module.Path,
				pkg.Module.Version,
			)
		}
		record := moduleRecord{
			Path:    strings.TrimSpace(pkg.Module.Path),
			Version: strings.TrimSpace(pkg.Module.Version),
			Sum:     strings.TrimSpace(pkg.Module.Sum),
			Dir:     strings.TrimSpace(pkg.Module.Dir),
		}
		if record.Path == "" || record.Version == "" || record.Sum == "" || record.Dir == "" {
			return nil, fmt.Errorf("listed module has incomplete source identity: %#v", record)
		}
		current, exists := modulesByPath[record.Path]
		if !exists {
			current = &listedModule{Record: record}
			modulesByPath[record.Path] = current
		} else if current.Record != record {
			return nil, fmt.Errorf(
				"listed module %s has conflicting source identities",
				record.Path,
			)
		}
		current.PackageDirs = append(current.PackageDirs, pkg.Dir)
	}

	modules := make([]listedModule, 0, len(modulesByPath))
	for _, module := range modulesByPath {
		sort.Strings(module.PackageDirs)
		module.PackageDirs = compactStrings(module.PackageDirs)
		modules = append(modules, *module)
	}
	sort.Slice(modules, func(i, j int) bool {
		return modules[i].Record.Path < modules[j].Record.Path
	})
	return modules, nil
}

func validateBinaryModules(binary []moduleIdentity, listed []moduleRecord) error {
	listedByPath := make(map[string]moduleRecord, len(listed))
	for _, module := range listed {
		if _, exists := listedByPath[module.Path]; exists {
			return fmt.Errorf("listed module %s appears more than once", module.Path)
		}
		listedByPath[module.Path] = module
	}
	binaryByPath := make(map[string]moduleIdentity, len(binary))
	for _, module := range binary {
		if _, exists := binaryByPath[module.Path]; exists {
			return fmt.Errorf("compiled module %s appears more than once", module.Path)
		}
		binaryByPath[module.Path] = module
		listedModule, exists := listedByPath[module.Path]
		if !exists {
			return fmt.Errorf(
				"compiled module %s@%s has no source/license evidence",
				module.Path,
				module.Version,
			)
		}
		if module.Version != listedModule.Version || module.Sum != listedModule.Sum {
			return fmt.Errorf(
				"compiled module %s source identity %s %s does not match listed source %s %s",
				module.Path,
				module.Version,
				module.Sum,
				listedModule.Version,
				listedModule.Sum,
			)
		}
	}
	for _, module := range listed {
		if _, exists := binaryByPath[module.Path]; !exists {
			return fmt.Errorf(
				"listed module %s@%s is not embedded in the built binary",
				module.Path,
				module.Version,
			)
		}
	}
	return nil
}

func collectModuleEvidence(module moduleRecord, packageDirs []string) (moduleEvidence, error) {
	moduleDir, err := filepath.Abs(module.Dir)
	if err != nil {
		return moduleEvidence{}, fmt.Errorf("resolve module directory for %s: %w", module.Path, err)
	}
	directories := map[string]struct{}{moduleDir: {}}
	for _, packageDir := range packageDirs {
		current, err := filepath.Abs(packageDir)
		if err != nil {
			return moduleEvidence{}, fmt.Errorf("resolve package directory for %s: %w", module.Path, err)
		}
		relative, err := filepath.Rel(moduleDir, current)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return moduleEvidence{}, fmt.Errorf(
				"compiled package directory %s escapes module %s",
				packageDir,
				module.Path,
			)
		}
		for {
			directories[current] = struct{}{}
			if current == moduleDir {
				break
			}
			parent := filepath.Dir(current)
			if parent == current {
				return moduleEvidence{}, fmt.Errorf(
					"compiled package directory %s has no module root %s",
					packageDir,
					moduleDir,
				)
			}
			current = parent
		}
	}

	orderedDirectories := make([]string, 0, len(directories))
	for directory := range directories {
		orderedDirectories = append(orderedDirectories, directory)
	}
	sort.Strings(orderedDirectories)

	filesByPath := make(map[string]evidenceFile)
	hasRootLicense := false
	for _, directory := range orderedDirectories {
		entries, err := os.ReadDir(directory)
		if err != nil {
			return moduleEvidence{}, fmt.Errorf("read license evidence directory %s: %w", directory, err)
		}
		for _, entry := range entries {
			kind, ok := evidenceKind(entry.Name())
			if !ok {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				return moduleEvidence{}, fmt.Errorf("inspect license evidence %s: %w", entry.Name(), err)
			}
			if !info.Mode().IsRegular() {
				return moduleEvidence{}, fmt.Errorf(
					"license evidence %s for %s is not a regular file",
					entry.Name(),
					module.Path,
				)
			}
			if info.Size() <= 0 || info.Size() > maxEvidenceFileBytes {
				return moduleEvidence{}, fmt.Errorf(
					"license evidence %s for %s has unsupported size %d",
					entry.Name(),
					module.Path,
					info.Size(),
				)
			}
			path := filepath.Join(directory, entry.Name())
			content, err := os.ReadFile(path)
			if err != nil {
				return moduleEvidence{}, fmt.Errorf("read license evidence %s: %w", path, err)
			}
			relative, err := filepath.Rel(moduleDir, path)
			if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
				return moduleEvidence{}, fmt.Errorf("license evidence %s escapes module %s", path, module.Path)
			}
			relative = filepath.ToSlash(relative)
			filesByPath[relative] = evidenceFile{Path: relative, Content: content}
			if directory == moduleDir && (kind == "license" || kind == "copying") {
				hasRootLicense = true
			}
		}
	}
	if !hasRootLicense {
		return moduleEvidence{}, fmt.Errorf(
			"module %s@%s has no root license evidence",
			module.Path,
			module.Version,
		)
	}

	files := make([]evidenceFile, 0, len(filesByPath))
	for _, file := range filesByPath {
		files = append(files, file)
	}
	sort.Slice(files, func(i, j int) bool {
		return files[i].Path < files[j].Path
	})
	return moduleEvidence{
		Identity: moduleIdentity{
			Path:    module.Path,
			Version: module.Version,
			Sum:     module.Sum,
		},
		Files: files,
	}, nil
}

func evidenceKind(name string) (string, bool) {
	lower := strings.ToLower(name)
	for _, kind := range []string{"license", "copying", "notice", "patents"} {
		if lower == kind ||
			strings.HasPrefix(lower, kind+".") ||
			strings.HasPrefix(lower, kind+"-") ||
			strings.HasPrefix(lower, kind+"_") {
			return kind, true
		}
	}
	return "", false
}

func renderNotice(goDistribution distributionEvidence, modules []moduleEvidence) ([]byte, error) {
	orderedModules := append([]moduleEvidence(nil), modules...)
	sort.Slice(orderedModules, func(i, j int) bool {
		return orderedModules[i].Identity.Path < orderedModules[j].Identity.Path
	})

	var output bytes.Buffer
	output.WriteString("CLIProxyAPI managed runtime third-party notices\n")
	output.WriteString("=================================================\n\n")
	output.WriteString("This file is generated from the exact Go toolchain and non-main Go modules\n")
	output.WriteString("embedded in the statically linked managed runtime. Toolchain/module versions\n")
	output.WriteString("and module checksums come from the built binary; evidence text comes from the\n")
	output.WriteString("matching Go distribution and checksum-verified module source used for that\n")
	output.WriteString("build. Do not edit this file manually.\n\n")

	if strings.TrimSpace(goDistribution.Version) == "" || len(goDistribution.Files) == 0 {
		return nil, errors.New("Go distribution has incomplete license evidence")
	}
	output.WriteString("================================================================================\n")
	fmt.Fprintf(&output, "Go toolchain %s\n", goDistribution.Version)
	fmt.Fprintf(&output, "source identity: %s\n", goDistribution.Version)
	fmt.Fprintf(&output, "source: https://go.dev/dl/%s.src.tar.gz\n", goDistribution.Version)
	files := append([]evidenceFile(nil), goDistribution.Files...)
	sort.Slice(files, func(i, j int) bool {
		return files[i].Path < files[j].Path
	})
	seenGoFiles := make(map[string]struct{}, len(files))
	for _, file := range files {
		if strings.TrimSpace(file.Path) == "" || len(file.Content) == 0 {
			return nil, fmt.Errorf("Go distribution %s has invalid evidence file %q", goDistribution.Version, file.Path)
		}
		if _, exists := seenGoFiles[file.Path]; exists {
			return nil, fmt.Errorf("Go distribution %s repeats evidence file %s", goDistribution.Version, file.Path)
		}
		seenGoFiles[file.Path] = struct{}{}
		output.WriteString("\n--------------------------------------------------------------------------------\n")
		fmt.Fprintf(&output, "evidence file: %s\n", file.Path)
		output.WriteString("--------------------------------------------------------------------------------\n")
		output.Write(file.Content)
		if file.Content[len(file.Content)-1] != '\n' {
			output.WriteByte('\n')
		}
	}
	output.WriteByte('\n')

	seenModules := make(map[string]struct{}, len(orderedModules))
	for _, module := range orderedModules {
		identity := module.Identity
		if identity.Path == "" || identity.Version == "" || identity.Sum == "" {
			return nil, fmt.Errorf("notice module has incomplete source identity: %#v", identity)
		}
		if _, exists := seenModules[identity.Path]; exists {
			return nil, fmt.Errorf("notice module %s appears more than once", identity.Path)
		}
		seenModules[identity.Path] = struct{}{}
		if len(module.Files) == 0 {
			return nil, fmt.Errorf("notice module %s has no license evidence files", identity.Path)
		}

		output.WriteString("================================================================================\n")
		fmt.Fprintf(&output, "%s %s\n", identity.Path, identity.Version)
		fmt.Fprintf(&output, "module checksum: %s\n", identity.Sum)
		fmt.Fprintf(&output, "module source: https://pkg.go.dev/%s@%s\n", identity.Path, identity.Version)

		files := append([]evidenceFile(nil), module.Files...)
		sort.Slice(files, func(i, j int) bool {
			return files[i].Path < files[j].Path
		})
		seenFiles := make(map[string]struct{}, len(files))
		for _, file := range files {
			if strings.TrimSpace(file.Path) == "" || len(file.Content) == 0 {
				return nil, fmt.Errorf("notice module %s has invalid evidence file %q", identity.Path, file.Path)
			}
			if _, exists := seenFiles[file.Path]; exists {
				return nil, fmt.Errorf("notice module %s repeats evidence file %s", identity.Path, file.Path)
			}
			seenFiles[file.Path] = struct{}{}
			fmt.Fprintf(&output, "\n--------------------------------------------------------------------------------\n")
			fmt.Fprintf(&output, "evidence file: %s\n", file.Path)
			output.WriteString("--------------------------------------------------------------------------------\n")
			output.Write(file.Content)
			if file.Content[len(file.Content)-1] != '\n' {
				output.WriteByte('\n')
			}
		}
		output.WriteByte('\n')
		if output.Len() > maxNoticeBytes {
			return nil, fmt.Errorf("third-party notices exceed %d bytes", maxNoticeBytes)
		}
	}
	return normalizeRenderedNotice(output.Bytes()), nil
}

func normalizeRenderedNotice(content []byte) []byte {
	normalized := strings.ReplaceAll(string(content), "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	lines := strings.Split(normalized, "\n")
	for index := range lines {
		lines[index] = strings.TrimRight(lines[index], " \t")
	}
	return []byte(strings.TrimRight(strings.Join(lines, "\n"), "\n") + "\n")
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
	keys := make([]string, 0, len(overrides))
	for name := range overrides {
		keys = append(keys, name)
	}
	sort.Strings(keys)
	for _, name := range keys {
		result = append(result, name+"="+overrides[name])
	}
	return result
}

func compactStrings(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	result := values[:1]
	for _, value := range values[1:] {
		if value != result[len(result)-1] {
			result = append(result, value)
		}
	}
	return result
}
