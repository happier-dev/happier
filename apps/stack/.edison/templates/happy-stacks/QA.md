---
# Edison QA canonical keys (recommended)
id: "{{id}}"
task_id: "{{task_id}}"
title: "{{title}}"
round: {{round}}

# hstack QA metadata (project-specific; preserved by Edison)
track: "<<FILL: upstream|fork|integration>>"
stack: "<<FILL: exp1>>"
components: []
component: "<<FILL: happy|happy-cli|happy-server-light|happy-server>>"
---

# {{title}}

## Validation Scope

- Task: {{task_id}}
- Round: {{round}}

## Automated Checks (hstack)

- Evidence capture (stack-scoped): `hstack edison --stack={{stack}} -- evidence capture {{task_id}}`

