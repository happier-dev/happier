from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from edison.core.task.repository import TaskRepository
from edison.core.utils.text import parse_frontmatter


def _get_project_root(ctx: Mapping[str, Any]) -> Path | None:
    project_root = ctx.get("project_root")
    if isinstance(project_root, Path):
        return project_root
    if isinstance(project_root, str) and project_root.strip():
        try:
            return Path(project_root).expanduser().resolve()
        except Exception:
            return None
    return None


def _load_task_frontmatter(ctx: Mapping[str, Any]) -> dict[str, Any] | None:
    task_id = ctx.get("task_id") or ctx.get("entity_id")
    if not task_id:
        task = ctx.get("task")
        if isinstance(task, Mapping):
            task_id = task.get("id")
    if not task_id:
        return None

    project_root = _get_project_root(ctx)
    repo = TaskRepository(project_root=project_root)
    try:
        path = repo.get_path(str(task_id))
    except Exception:
        return None

    try:
        doc = parse_frontmatter(path.read_text(encoding="utf-8", errors="strict"))
        fm = doc.frontmatter
        return fm if isinstance(fm, dict) else {}
    except Exception:
        return None


def _require_stack_context(ctx: Mapping[str, Any], fm: Mapping[str, Any]) -> bool:
    # Enforce that Edison is running inside a Happy Stacks stack context.
    hs_kind = str(fm.get("hs_kind") or "").strip().lower()
    # Parent tasks are planning/umbrella tasks that may span multiple tracks/stacks.
    # They must NOT be claimed/finished directly (enforced elsewhere), so we do not
    # require a stack context here to avoid forcing an arbitrary stack.
    if hs_kind == "parent":
        return True

    stack_env = str(os.environ.get("HAPPY_STACKS_STACK") or os.environ.get("HAPPY_LOCAL_STACK") or "").strip()
    stack_task = str(fm.get("stack") or "").strip()
    if not stack_task:
        raise ValueError(
            "Happy Stacks: missing required task frontmatter key `stack`.\n"
            "Fix: edit the task file and set:\n"
            "  stack: <stack>\n"
            "Then run Edison via:\n"
            "  happys edison --stack=<stack> -- <edison ...>"
        )
    if not stack_env:
        raise ValueError(
            "Happy Stacks: missing stack context (HAPPY_STACKS_STACK).\n"
            "Fix: run Edison through the stack wrapper:\n"
            f"  happys edison --stack={stack_task} -- <edison ...>"
        )
    if stack_env != stack_task:
        raise ValueError(
            "Happy Stacks: stack mismatch.\n"
            f"- env stack: {stack_env}\n"
            f"- task stack: {stack_task}\n"
            "Fix: re-run with:\n"
            f"  happys edison --stack={stack_task} -- <edison ...>"
        )
    return stack_env == stack_task


def _get_parent_id_from_relationships(fm: Mapping[str, Any]) -> str | None:
    rels = fm.get("relationships")
    if not isinstance(rels, list):
        return None
    for e in rels:
        if not isinstance(e, Mapping):
            continue
        if str(e.get("type") or "").strip() == "parent":
            t = str(e.get("target") or "").strip()
            return t or None
    return None


def _require_base_metadata(ctx: Mapping[str, Any], fm: Mapping[str, Any]) -> bool:
    hs_kind = str(fm.get("hs_kind") or "").strip().lower()
    if hs_kind not in {"parent", "track", "component"}:
        raise ValueError(
            "Happy Stacks: missing/invalid `hs_kind`.\n"
            "Fix: set `hs_kind: parent|track|component` in task frontmatter."
        )

    if hs_kind == "parent":
        # Parent tasks are planning roots; base_task is optional (but recommended).
        return True

    base_task = str(fm.get("base_task") or "").strip()
    if not base_task:
        task_id = ctx.get("task_id") or ctx.get("entity_id") or ""
        raise ValueError(
            "Happy Stacks: missing required task frontmatter key `base_task`.\n"
            "Fix (recommended):\n"
            f"  happys edison task:scaffold {task_id} --yes\n"
            "Or set:\n"
            "  base_task: <parent-feature-task-id>"
        )

    if hs_kind == "component":
        base_wt = str(fm.get("base_worktree") or "").strip()
        if not base_wt:
            task_id = ctx.get("task_id") or ctx.get("entity_id") or ""
            raise ValueError(
                "Happy Stacks: missing required task frontmatter key `base_worktree`.\n"
                "Fix (recommended):\n"
                f"  happys edison task:scaffold {task_id} --yes\n"
                "Or set:\n"
                "  base_worktree: edison/<task-id>"
            )
    return True


def _require_worktree_component_dirs(fm: Mapping[str, Any]) -> bool:
    # Best-effort enforcement: ensure the active stack points components at worktree paths.
    # This is intentionally strict (fail-closed) because editing default component checkouts
    # is disallowed in Happy Stacks.
    hs_kind = str(fm.get("hs_kind") or "").strip().lower()
    if hs_kind not in {"track", "component"}:
        raise ValueError(
            "Happy Stacks: missing/invalid `hs_kind`.\n"
            "Fix:\n"
            "  - set `hs_kind: track` on the track/integration task\n"
            "  - set `hs_kind: component` on each component implementation task"
        )

    comps: list[str] = []
    if hs_kind == "track":
        v = fm.get("components")
        if isinstance(v, list):
            comps = [str(x).strip() for x in v if str(x).strip()]
        elif isinstance(v, str) and v.strip():
            comps = [p.strip() for p in v.split(",") if p.strip()]
    else:
        v = fm.get("component")
        if isinstance(v, str) and v.strip():
            comps = [v.strip()]
        else:
            v2 = fm.get("components")
            if isinstance(v2, list):
                comps = [str(x).strip() for x in v2 if str(x).strip()]
            elif isinstance(v2, str) and v2.strip():
                comps = [p.strip() for p in v2.split(",") if p.strip()]
        if len(comps) != 1:
            raise ValueError(
                "Happy Stacks: component task must target exactly one component.\n"
                "Fix: set `component: happy` (or `components: [happy]`)."
            )

    if not comps:
        raise ValueError(
            "Happy Stacks: task must declare component(s) in frontmatter.\n"
            "Fix: set `components: [...]` (parent) or `component: ...` (component subtask)."
        )

    for c in comps:
        key = f"HAPPY_STACKS_COMPONENT_DIR_{c.upper().replace('-', '_')}"
        legacy = f"HAPPY_LOCAL_COMPONENT_DIR_{c.upper().replace('-', '_')}"
        path = str(os.environ.get(key) or os.environ.get(legacy) or "").strip()
        if not path:
            raise ValueError(
                f"Happy Stacks: missing stack component dir override for {c}.\n"
                "Fix (recommended):\n"
                "  happys edison task:scaffold <task-id> --yes\n"
                "Or manually:\n"
                f"  happys wt new {c} edison/<task-id>\n"
                f"  happys stack wt <stack> -- use {c} /abs/path/to/worktree"
            )
        # Require the component dir to be a worktree checkout.
        if "/components/.worktrees/" not in path.replace("\\", "/"):
            raise ValueError(
                f"Happy Stacks: component dir for {c} is not a worktree path.\n"
                "Refusing to operate on default checkouts under components/<component>.\n"
                "Fix (recommended):\n"
                "  happys edison task:scaffold <task-id> --yes\n"
                "Or:\n"
                f"  happys stack wt <stack> -- use {c} <owner/branch|/abs/path>"
            )

    return True


def _require_parent_subtask_structure(ctx: Mapping[str, Any], fm: Mapping[str, Any]) -> bool:
    hs_kind = str(fm.get("hs_kind") or "").strip().lower()
    if hs_kind not in {"parent", "track", "component"}:
        raise ValueError("Happy Stacks: missing/invalid `hs_kind` (expected parent|track|component).")

    if hs_kind == "parent":
        # Parent tasks are planning roots and must NOT be claimed/finished directly.
        raise ValueError(
            "Happy Stacks: refusing to claim/finish a parent task.\n"
            "Parent tasks are planning umbrellas and should spawn track + component subtasks.\n"
            "Fix (recommended):\n"
            "  - Create a track task (hs_kind=track) as a child of this parent\n"
            "  - Create component tasks (hs_kind=component) as children of the track\n"
            "  - Or run:\n"
            f"    happys edison task:scaffold {ctx.get('task_id') or ctx.get('entity_id') or '<parent-task-id>'} --yes\n"
        )

    parent_id = _get_parent_id_from_relationships(fm)
    if not parent_id:
        raise ValueError(
            "Happy Stacks: task must have a parent relationship (canonical `relationships:`).\n"
            "Fix:\n"
            "  edison task link <parent_id> <child_id>\n"
            "Or (recommended):\n"
            "  happys edison task:scaffold <parent-task-id> --yes"
        )

    # Validate the parent task's hs_kind and stack invariants by loading its frontmatter.
    project_root = _get_project_root(ctx)
    repo = TaskRepository(project_root=project_root)
    parent = repo.get(str(parent_id))
    if not parent:
        raise ValueError(
            f"Happy Stacks: parent task not found: {parent_id}\n"
            "Fix: ensure the parent task exists or re-link tasks."
        )
    try:
        parent_path = repo.get_path(str(parent.id))
        parent_fm = parse_frontmatter(parent_path.read_text(encoding="utf-8", errors="strict")).frontmatter
        parent_fm = parent_fm if isinstance(parent_fm, Mapping) else {}
    except Exception:
        parent_fm = {}

    parent_kind = str(parent_fm.get("hs_kind") or "").strip().lower()
    if hs_kind == "track":
        if parent_kind != "parent":
            raise ValueError(
                "Happy Stacks: track tasks must be children of a parent task.\n"
                f"- this task: hs_kind=track\n"
                f"- parent: {parent_id} hs_kind={parent_kind or '<missing>'}\n"
                "Fix: link the track under the umbrella parent task."
            )
        # Track tasks must declare components and a track name.
        track_name = str(fm.get("track") or "").strip()
        if not track_name:
            raise ValueError(
                "Happy Stacks: track task must declare `track` (e.g. upstream|fork|integration).\n"
                "Fix: set `track: upstream` in task frontmatter."
            )
        v = fm.get("components")
        comps: list[str] = []
        if isinstance(v, list):
            comps = [str(x).strip() for x in v if str(x).strip()]
        elif isinstance(v, str) and v.strip():
            comps = [p.strip() for p in v.split(",") if p.strip()]
        if len(comps) == 0:
            raise ValueError(
                "Happy Stacks: track task must declare `components`.\n"
                "Fix: set `components: [happy, happy-cli, ...]` in task frontmatter."
            )
        return True

    # component task: must be under a track, and must share the same stack.
    if parent_kind != "track":
        raise ValueError(
            "Happy Stacks: component tasks must be children of a track task.\n"
            f"- this task: hs_kind=component\n"
            f"- parent: {parent_id} hs_kind={parent_kind or '<missing>'}\n"
            "Fix: link this component task under the correct track task."
        )
    parent_stack = str(parent_fm.get("stack") or "").strip()
    this_stack = str(fm.get("stack") or "").strip()
    if parent_stack and this_stack and parent_stack != this_stack:
        raise ValueError(
            "Happy Stacks: component task stack must match its track stack.\n"
            f"- track stack: {parent_stack}\n"
            f"- task stack: {this_stack}\n"
            "Fix: set this task's `stack` to match the track task."
        )
    return True


def can_start_task(ctx: Mapping[str, Any]) -> bool:
    """Happy Stacks override of builtin can_start_task (FAIL-CLOSED)."""
    try:
        from edison.core.state.builtin.guards import task as builtin_task_guards
        if not builtin_task_guards.can_start_task(ctx):
            return False
    except Exception:
        return False

    fm = _load_task_frontmatter(ctx)
    if not isinstance(fm, Mapping):
        raise ValueError("Happy Stacks: cannot read task frontmatter (missing/invalid YAML frontmatter).")

    return (
        _require_stack_context(ctx, fm)
        and _require_parent_subtask_structure(ctx, fm)
        and _require_base_metadata(ctx, fm)
        and _require_worktree_component_dirs(fm)
    )


def can_finish_task(ctx: Mapping[str, Any]) -> bool:
    """Happy Stacks override of builtin can_finish_task (FAIL-CLOSED)."""
    try:
        from edison.core.state.builtin.guards import task as builtin_task_guards
        if not builtin_task_guards.can_finish_task(ctx):
            return False
    except Exception:
        return False

    fm = _load_task_frontmatter(ctx)
    if not isinstance(fm, Mapping):
        raise ValueError("Happy Stacks: cannot read task frontmatter (missing/invalid YAML frontmatter).")

    # Must still be in the correct stack context when marking done/validated.
    return _require_stack_context(ctx, fm) and _require_parent_subtask_structure(ctx, fm) and _require_base_metadata(ctx, fm) and _require_worktree_component_dirs(fm)

