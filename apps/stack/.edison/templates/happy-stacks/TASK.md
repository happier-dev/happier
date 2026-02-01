---
# hstack task planning metadata (MANDATORY)
#
# This metadata is enforced by happy-stacks guards on claim/done transitions.
# Agents MUST run Edison inside a stack context:
#   hstack edison --stack=<stack> -- <edison ...>
#
# hs_kind:
# - parent: umbrella planning task for a feature (NOT claimable; use track/component tasks)
# - track: integration task that owns ONE stack (one stack per track) and lists involved components
# - component: implementation task that targets exactly one component and is a child of a track task
hs_kind: "<<FILL: parent|track|component>>"

# Track name (required for hs_kind=track; recommended for component):
track: "<<FILL: upstream|fork|integration>>"

# Stack that must be used for implementation + evidence capture.
# Required for hs_kind=track|component. (Parent tasks may span multiple tracks/stacks.)
stack: "<<FILL: exp1>>"

# Base feature task ID (required for hs_kind=track|component; recommended for parent).
base_task: "<<FILL: parent-feature-task-id>>"

# Default worktree branch/slug used for this task (required for hs_kind=component).
# Example: edison/<task-id>
base_worktree: "<<FILL: edison/<task-id>>"

# Components affected by this task.
# - For hs_kind=parent: list all components involved across tracks
# - For hs_kind=track: list all components pinned into this track's stack
# - For hs_kind=component: set exactly one component here OR fill `component:` below
components: []

# For hs_kind=component you may use `component` instead of `components` for clarity:
component: "<<FILL: happy|happy-cli|happy-server-light|happy-server>>"
---

# {{title}}

## Summary

{{description}}

## hstack Execution Plan (MANDATORY)

- [ ] Create/confirm a dedicated stack: `hstack stack new {{stack}} --interactive`
- [ ] Create/confirm a component worktree per component
- [ ] Point the stack at the worktree(s): `hstack stack wt {{stack}} -- use ...`
- [ ] Implement only inside component worktree paths (never default checkouts)
- [ ] Capture evidence via stack-scoped runner:
  - `hstack edison --stack={{stack}} -- evidence capture {{id}}`

## Primary Files / Areas

- <<FILL: path(s)>>

