# Advanced Public Cross-plugin Contribution Contributor

This copyable plugin contributes the local `local-document-reviewer` binding
to the target plugin's `document-reviewers` point through the canonical Triage
protocol. Its required source roles deliberately bind to this package's arbitrary
local Action ids.

That Action remains an ordinary plugin Action. This package does not search
global Action ids, self-register with the target, or provide a fallback
dispatcher. The example stops at the public authoring declaration boundary.
Because Triage also declares descriptor and embedded-surface roles, this pair is
an advanced public Developer Preview proof. External and bundled plugins use
the same public contracts and physical host. The generated
`capability-matrix.json` remains the availability authority; this README does
not create a separate support tier or claim loaded-platform or publication
proof.

Build, test, and load this plugin independently through the normal managed
source-author commands:

```sh
happier plugins dev build .
happier plugins test .
happier plugins dev
```
