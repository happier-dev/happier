# First-party Preview Cross-plugin Contribution Contributor

This copyable plugin contributes the local `local-document-reviewer` binding
to the target plugin's `document-reviewers` point. The protocol role is named
`review`, but it deliberately binds to this package's arbitrary local Action
id, `prepare-document-review`.

That Action remains an ordinary plugin Action. This package does not search
global Action ids, self-register with the target, or provide a fallback
dispatcher. The example stops at the public authoring declaration boundary.
Because Triage also declares descriptor and embedded-surface roles, this pair is
classified as first-party Preview. The externally supported author product
remains operation-only.

Build and pack this plugin independently with the normal author commands:

```sh
happier plugins author build .
happier plugins pack .
```
