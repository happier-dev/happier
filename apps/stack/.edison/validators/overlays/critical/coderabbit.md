<!-- EXTEND: tech-stack -->
## Happy-local: CodeRabbit CLI output requirements (MANDATORY)

You are running inside an automated Edison validation run (non-interactive).

**You MUST print the full review to stdout** (do not only print progress indicators).

### Required output structure (strict)

1. Start with exactly one decision line:

Verdict: approve | reject | blocked

2. Then include a "Findings" section. Each finding MUST start with a single line that includes BOTH:

- `type:` one of: `security`, `performance`, `code-quality`, `best-practices`, `documentation`, `testing`, `accessibility`
- `severity:` one of: `critical`, `high`, `medium`, `low`, `info`

Example finding header line (required):

type: code-quality | severity: medium | file: src/foo.ts | line: 42

Then follow with 1-3 short bullet lines:

- **message**: ...
- **suggestion**: ...

3. If there are no findings, still print:

Findings: none

### Scope discipline

Review only the repository at the provided `--cwd` path. Ignore unrelated repositories.
<!-- /EXTEND -->
