package thirdpartynotices

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCollectModuleEvidenceFailsClosedWithoutRootLicense(t *testing.T) {
	t.Parallel()

	moduleDir := t.TempDir()
	packageDir := filepath.Join(moduleDir, "client")
	if err := os.MkdirAll(packageDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(moduleDir, "NOTICE"), []byte("notice only\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := collectModuleEvidence(moduleRecord{
		Path:    "example.com/missing-license",
		Version: "v1.2.3",
		Sum:     "h1:source-checksum",
		Dir:     moduleDir,
	}, []string{packageDir})
	if err == nil || !strings.Contains(err.Error(), "root license evidence") {
		t.Fatalf("collectModuleEvidence() error = %v, want missing root license evidence", err)
	}
}

func TestValidateBinaryModulesRejectsUnknownCompiledModule(t *testing.T) {
	t.Parallel()

	listed := []moduleRecord{{
		Path:    "example.com/known",
		Version: "v1.0.0",
		Sum:     "h1:known",
	}}
	binary := []moduleIdentity{
		{Path: "example.com/known", Version: "v1.0.0", Sum: "h1:known"},
		{Path: "example.com/unknown", Version: "v2.0.0", Sum: "h1:unknown"},
	}

	err := validateBinaryModules(binary, listed)
	if err == nil || !strings.Contains(err.Error(), "example.com/unknown@v2.0.0") {
		t.Fatalf("validateBinaryModules() error = %v, want unknown compiled module", err)
	}
}

func TestValidateBinaryModulesRejectsListedModuleMissingFromBinary(t *testing.T) {
	t.Parallel()

	listed := []moduleRecord{{
		Path:    "example.com/listed",
		Version: "v1.0.0",
		Sum:     "h1:listed",
	}}

	err := validateBinaryModules(nil, listed)
	const expected = "listed module example.com/listed@v1.0.0 is not embedded in the built binary"
	if err == nil || err.Error() != expected {
		t.Fatalf("validateBinaryModules() error = %v, want %q", err, expected)
	}
}

func TestValidateGoDistributionRejectsToolchainVersionDifferentFromBinary(t *testing.T) {
	t.Parallel()

	err := validateGoDistribution(
		"go1.26.4",
		goEnvironment{
			Version: "go1.26.5",
			Root:    "/opt/go",
		},
	)
	const expected = "built binary Go version go1.26.4 does not match source toolchain go1.26.5"
	if err == nil || err.Error() != expected {
		t.Fatalf("validateGoDistribution() error = %v, want %q", err, expected)
	}
}

func TestRenderNoticeIsDeterministicAndSourcePinned(t *testing.T) {
	t.Parallel()

	modules := []moduleEvidence{
		{
			Identity: moduleIdentity{
				Path:    "example.com/zeta",
				Version: "v2.0.0",
				Sum:     "h1:zeta-source",
			},
			Files: []evidenceFile{
				{Path: "NOTICE", Content: []byte("zeta notice\n")},
				{Path: "LICENSE", Content: []byte("zeta license without newline")},
			},
		},
		{
			Identity: moduleIdentity{
				Path:    "example.com/alpha",
				Version: "v1.0.0",
				Sum:     "h1:alpha-source",
			},
			Files: []evidenceFile{{
				Path:    "LICENSE.txt",
				Content: []byte("alpha license\n"),
			}},
		},
	}

	goDistribution := distributionEvidence{
		Version: "go1.26.5",
		Files: []evidenceFile{
			{Path: "PATENTS", Content: []byte("Go patents\n")},
			{Path: "LICENSE", Content: []byte("Go license\n")},
		},
	}

	first, err := renderNotice(goDistribution, modules)
	if err != nil {
		t.Fatal(err)
	}
	second, err := renderNotice(goDistribution, []moduleEvidence{modules[1], modules[0]})
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Fatalf("renderNotice() changed with input order")
	}

	rendered := string(first)
	alpha := strings.Index(rendered, "example.com/alpha v1.0.0")
	zeta := strings.Index(rendered, "example.com/zeta v2.0.0")
	if alpha < 0 || zeta < 0 || alpha >= zeta {
		t.Fatalf("module order is not deterministic:\n%s", rendered)
	}
	for _, expected := range []string{
		"Go toolchain go1.26.5",
		"evidence file: LICENSE\n",
		"evidence file: PATENTS\n",
		"module checksum: h1:alpha-source",
		"module checksum: h1:zeta-source",
		"evidence file: LICENSE",
		"evidence file: NOTICE",
		"zeta license without newline\n",
	} {
		if !strings.Contains(rendered, expected) {
			t.Fatalf("renderNotice() missing %q:\n%s", expected, rendered)
		}
	}
	if strings.Contains(rendered, " \n") || strings.Contains(rendered, "\t\n") {
		t.Fatalf("renderNotice() retained trailing horizontal whitespace:\n%q", rendered)
	}
	if !strings.HasSuffix(rendered, "\n") || strings.HasSuffix(rendered, "\n\n") {
		t.Fatalf("renderNotice() must end in exactly one newline:\n%q", rendered)
	}
}

func TestRenderNoticeNormalizesEvidenceWhitespace(t *testing.T) {
	t.Parallel()

	rendered, err := renderNotice(
		distributionEvidence{
			Version: "go1.26.5",
			Files: []evidenceFile{{
				Path:    "LICENSE",
				Content: []byte("Go license with trailing spaces  \r\n\r\n"),
			}},
		},
		[]moduleEvidence{{
			Identity: moduleIdentity{
				Path:    "example.com/notice-whitespace",
				Version: "v1.0.0",
				Sum:     "h1:notice-whitespace",
			},
			Files: []evidenceFile{{
				Path:    "LICENSE",
				Content: []byte("module line with trailing tab\t\n\n"),
			}},
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(rendered), " \n") || strings.Contains(string(rendered), "\t\n") {
		t.Fatalf("renderNotice() retained trailing horizontal whitespace:\n%q", rendered)
	}
	if !strings.HasSuffix(string(rendered), "\n") || strings.HasSuffix(string(rendered), "\n\n") {
		t.Fatalf("renderNotice() must end in exactly one newline:\n%q", rendered)
	}
}
