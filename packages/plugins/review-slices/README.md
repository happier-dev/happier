# Slice reviews

This 0.3 development package declares the native executable through the host's
managed JavaScript-package installer. The observed external contract is the
published `clawpatch@0.8.4` npm package. Its execution-run Agent and review
profile consume the shared admitted repository scope, validated engine options
and namespaced finding extensions through the public SDK.

`runSliceReview` accepts host Exec/filesystem services and an admitted repository
and plugin-owned repository storage path. Native state lives beneath the existing durable
plugin data root, outside the repository. Initialization happens only when native
project state is absent; subsequent runs preserve the engine's state.

The engine owns mapping and slice scheduling. The adapter supplies an explicit
list of active slice IDs because the native default selects only one slice. A
temporary selection file uses the SDK's existing temporary-directory owner and
is removed when the native review command settles. No host slice loop, retry
budget, hook or fix command is added.

The selected native run's finding IDs are joined to full native records. Historical
report totals cannot become findings. Normalization retains reasoning, evidence,
suggestion and typed native reproduction/test-gap/slice metadata; categorical
confidence is retained as native evidence rather than converted to an invented
number. Failed runs retain substantive findings and remain failed. Local Stop
cancels Exec without deleting native state. Canonical finding identities and
human decisions remain owned by Happier's shared review flow.
