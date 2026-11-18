# Panel reviews

This 0.3 development plugin contributes the Panel reviewer Agent and Review
profile. Shared Review admission owns comparison scope and validates this
profile's options. The plugin translates admitted inputs into the native CLI
and returns ordinary findings through the shared review result contract.

The managed dependency uses the host's latest GitHub release acquisition. The
native contract was verified against the published v0.75.0 executable. Its
[`job show --json` document](https://github.com/kenn-io/roborev/blob/v0.75.0/pkg/structuredreview/document.go)
is the result contract. The fixture under `src/agent/reviews/fixtures` was
captured from that published executable using native panel synthesis and a
deterministic model process stub, without credentials or model calls.

The profile exposes panel name, review type, native Agent and reasoning effort.
The shared model selection supplies the native model flag. A named panel and
its members are configured in the repository's `.roborev.toml`; `none` selects
one reviewer. Native model access uses the executing Machine's configuration;
connected Provider bindings are reported as unsupported. Committed captured
endpoints and uncommitted working-tree changes are supported. Repository-wide
and combined committed/uncommitted reviews are unsupported.

`runPanelReview` takes host Exec/filesystem services and already admitted native
scope/options arguments. Every create run uses a separate `runs/<runId>` directory
under the host's durable plugin data root. It starts the native daemon only for
the run, writes the admitted instructions as native `review_guidelines`,
enqueues one review with `--quiet`, reads the selected job id from one native
JSON job listing, waits for that job, reads its stored structured document,
and stops the daemon. The native listing hides panel members under the
synthesis job. A missing or ambiguous top-level job is a failure. The host
issues a unique run id; resume/fork are unsupported, so this listing contains
only the current invocation. No review history is imported.

Native `--quiet` suppresses automatic hook installation/maintenance. Ordinary
submission can upgrade existing hooks, and the native CLI filters Git config
environment overrides, so those overrides cannot suppress maintenance. Native
telemetry is disabled. Installation is an explicit host action, never a review
side effect.

Stop takes effect after short native start/enqueue/job-id acquisition returns;
the CLI owns those operations' deadlines. An interrupted wait cancels the
selected native job (which cascades to panel members) before daemon shutdown.
Cleanup runs without the canceled signal. A cleanup error remains visible
alongside the primary run/cancellation error. The native process can fail to
stop when its own cancellation or shutdown fails; that is reported as failure.

Findings retain their suggested fix and native source attribution. Native
verdicts remain evidence, separate from a person's verdict. An absent or unknown
structured document is unsupported, an unable-to-review result is failed, and failed panel
members preserve substantive findings with partial completeness. Typed native
evidence occupies the `happier.review.panels` finding extension. Native enqueue
and wait completion supply progress events; no synthesized percentages, idle
watcher, daemon tail, timer or retry is added.
