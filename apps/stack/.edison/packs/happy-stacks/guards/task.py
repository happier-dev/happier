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
    # Enforce that Edison is running inside a Hapsta stack context.
    hs_kind = str(fm.get("hs_kind") or "").strip().lower()
    # Parent tasks are planning/umbrella tasks that may span multiple tracks/stacks.
    # They must NOT be claimed/finished directly (enforced elsewhere), so we do not
    # require a stack context here to avoid forcing an arbitrary stack.
    if hs_kind == "parent":
        return True

    stack_env = str(os.environ.get("HAPPIER_STACK_STACK") or "").strip()
    stack_task = str(fm.get("stack") or "").strip()
    if not stack_task:
        raise ValueError(
            "Hapsta: missing required task frontmatter key `stack`.\n"
            "Fix: edit the task file and set:\n"
            "  stack: <stack>\n"
            "Then run Edison via:\n"
            "  hapsta edison --stack=<stack> -- <edison ...>"
        )
    if not stack_env:
        raise ValueError(
            "Hapsta: missing stack context (HAPPIER_STACK_STACK).\n"
            "Fix: run Edison through the stack wrapper:\n"
            f"  hapsta edison --stack={stack_task} -- <edison ...>"
        )
    if stack_env != stack_task:
        raise ValueError(
            "Hapsta: stack mismatch.\n"
            f"- env stack: {stack_env}\n"
            f"- task stack: {stack_task}\n"
            "Fix: re-run with:\n"
            f"  hapsta edison --stack={stack_task} -- <edison ...>"
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
            "Hapsta: missing/invalid `hs_kind`.\n"
            "Fix: set `hs_kind: parent|track|component` in task frontmatter."
        )

    if hs_kind == "parent":
        # Parent tasks are planning roots; base_task is optional (but recommended).
        return True

    base_task = str(fm.get("base_task") or "").strip()
    if not base_task:
        task_id = ctx.get("task_id") or ctx.get("entity_id") or ""
        raise ValueError(
            "Hapsta: missing required task frontmatter key `base_task`.\n"
            "Fix (recommended):\n"
            f"  hapsta edison task:scaffold {task_id} --yes\n"
            "Or set:\n"
            "  base_task: <parent-feature-task-id>"
        )

    if hs_kind == "component":
        base_wt = str(fm.get("base_worktree") or "").strip()
        if not base_wt:
            task_id = ctx.get("task_id") or ctx.get("entity_id") or ""
            raise ValueError(
                "Hapsta: missing required task frontmatter key `base_worktree`.\n"
                "Fix (recommended):\n"
                f"  hapsta edison task:scaffold {task_id} --yes\n"
                "Or set:\n"
                "  base_worktree: edison/<task-id>"
            )
    return True


def _require_worktree_repo_dir(fm: Mapping[str, Any]) -> bool:
    # Fail-closed enforcement: ensure the active stack points at a repo worktree.
    # This is intentionally strict because editing the default checkout is disallowed.
    hs_kind = str(fm.get("hs_kind") or "").strip().lower()
    if hs_kind not in {"track", "component"}:
        raise ValueError(
            "Hapsta: missing/invalid `hs_kind`.\n"
            "Fix:\n"
            "  - set `hs_kind: track` on the track/integration task\n"
            "  - set `hs_kind: component` on each component implementation task"
        )

    repo_dir = str(os.environ.get("HAPPIER_STACK_REPO_DIR") or "").strip()
    if not repo_dir:
        raise ValueError(
            "Hapsta: missing stack repo dir override (HAPPIER_STACK_REPO_DIR).\n"
            "Fix (recommended):\n"
            "  hapsta edison task:scaffold <task-id> --yes\n"
            "Or manually:\n"
            "  hapsta wt new edison/<task-id> --from=upstream --use\n"
            "  hapsta stack wt <stack> -- use <owner/branch|/abs/path>"
        )

    p = repo_dir.replace("\\", "/")
    if "/.worktrees/" not in p:
        raise ValueError(
            "Hapsta: repo dir is not a worktree path.\n"
            "Refusing to operate on the default checkout.\n"
            "Fix:\n"
            "  hapsta wt new edison/<task-id> --from=upstream --use\n"
            "  hapsta stack wt <stack> -- use <owner/branch|/abs/path>"
        )

    if not (Path(repo_dir) / ".git").exists():
        raise ValueError(
            "Hapsta: repo dir does not look like a git checkout (missing .git).\n"
            f"- repo: {repo_dir}"
        )

    return True


def _require_parent_subtask_structure(ctx: Mapping[str, Any], fm: Mapping[str, Any]) -> bool:
    hs_kind = str(fm.get("hs_kind") or "").strip().lower()
    if hs_kind not in {"parent", "track", "component"}:
        raise ValueError("Hapsta: missing/invalid `hs_kind` (expected parent|track|component).")

    if hs_kind == "parent":
        # Parent tasks are planning roots and must NOT be claimed/finished directly.
        raise ValueError(
            "Hapsta: refusing to claim/finish a parent task.\n"
            "Parent tasks are planning umbrellas and should spawn track + component subtasks.\n"
            "Fix (recommended):\n"
            "  - Create a track task (hs_kind=track) as a child of this parent\n"
            "  - Create component tasks (hs_kind=component) as children of the track\n"
            "  - Or run:\n"
            f"    hapsta edison task:scaffold {ctx.get('task_id') or ctx.get('entity_id') or '<parent-task-id>'} --yes\n"
        )

    parent_id = _get_parent_id_from_relationships(fm)
    if not parent_id:
        raise ValueError(
            "Hapsta: task must have a parent relationship (canonical `relationships:`).\n"
            "Fix:\n"
            "  edison task link <parent_id> <child_id>\n"
            "Or (recommended):\n"
            "  hapsta edison task:scaffold <parent-task-id> --yes"
        )

    # Validate the parent task's hs_kind and stack invariants by loading its frontmatter.
    project_root = _get_project_root(ctx)
    repo = TaskRepository(project_root=project_root)
    parent = repo.get(str(parent_id))
    if not parent:
        raise ValueError(
            f"Hapsta: parent task not found: {parent_id}\n"
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
                "Hapsta: track tasks must be children of a parent task.\n"
                f"- this task: hs_kind=track\n"
                f"- parent: {parent_id} hs_kind={parent_kind or '<missing>'}\n"
                "Fix: link the track under the umbrella parent task."
            )
        # Track tasks must declare components and a track name.
        track_name = str(fm.get("track") or "").strip()
        if not track_name:
            raise ValueError(
                "Hapsta: track task must declare `track` (e.g. upstream|fork|integration).\n"
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
                "Hapsta: track task must declare `components`.\n"
                "Fix: set `components: [happy, happy-cli, ...]` in task frontmatter."
            )
        return True

    # component task: must be under a track, and must share the same stack.
    if parent_kind != "track":
        raise ValueError(
            "Hapsta: component tasks must be children of a track task.\n"
            f"- this task: hs_kind=component\n"
            f"- parent: {parent_id} hs_kind={parent_kind or '<missing>'}\n"
            "Fix: link this component task under the correct track task."
        )
    parent_stack = str(parent_fm.get("stack") or "").strip()
    this_stack = str(fm.get("stack") or "").strip()
    if parent_stack and this_stack and parent_stack != this_stack:
        raise ValueError(
            "Hapsta: component task stack must match its track stack.\n"
            f"- track stack: {parent_stack}\n"
            f"- task stack: {this_stack}\n"
            "Fix: set this task's `stack` to match the track task."
        )
    return True


def can_start_task(ctx: Mapping[str, Any]) -> bool:
    """Hapsta override of builtin can_start_task (FAIL-CLOSED)."""
    try:
        from edison.core.state.builtin.guards import task as builtin_task_guards
        if not builtin_task_guards.can_start_task(ctx):
            return False
    except Exception:
        return False

    fm = _load_task_frontmatter(ctx)
    if not isinstance(fm, Mapping):
        raise ValueError("Hapsta: cannot read task frontmatter (missing/invalid YAML frontmatter).")

    return (
        _require_stack_context(ctx, fm)
        and _require_parent_subtask_structure(ctx, fm)
        and _require_base_metadata(ctx, fm)
        and _require_worktree_repo_dir(fm)
    )


def can_finish_task(ctx: Mapping[str, Any]) -> bool:
    """Hapsta override of builtin can_finish_task (FAIL-CLOSED)."""
    try:
        from edison.core.state.builtin.guards import task as builtin_task_guards
        if not builtin_task_guards.can_finish_task(ctx):
            return False
    except Exception:
        return False

    fm = _load_task_frontmatter(ctx)
    if not isinstance(fm, Mapping):
        raise ValueError("Hapsta: cannot read task frontmatter (missing/invalid YAML frontmatter).")

    # Must still be in the correct stack context when marking done/validated.
    return _require_stack_context(ctx, fm) and _require_parent_subtask_structure(ctx, fm) and _require_base_metadata(ctx, fm) and _require_worktree_repo_dir(fm)
