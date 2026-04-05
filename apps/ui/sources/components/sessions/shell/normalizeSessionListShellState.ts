import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

const EMPTY_COLLAPSED_GROUP_KEYS: Readonly<Record<string, boolean>> = Object.freeze({});
const EMPTY_SESSION_TAGS: Readonly<Record<string, string[]>> = Object.freeze({});
const EMPTY_WORKSPACE_LABELS: Readonly<Record<string, string>> = Object.freeze({});
const EMPTY_WORKSPACE_REFS: ReadonlyArray<WorkspaceRefV1> = Object.freeze([] as WorkspaceRefV1[]);

export type NormalizedSessionListShellState = Readonly<{
    collapsedGroupKeys: Readonly<Record<string, boolean>>;
    sessionTags: Readonly<Record<string, string[]>>;
    workspaceLabels: Readonly<Record<string, string>>;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>;
}>;

export function normalizeSessionListShellState(input: Readonly<{
    collapsedGroupKeys: Readonly<Record<string, boolean> | null | undefined>;
    sessionTags: Readonly<Record<string, string[]> | null | undefined>;
    workspaceLabels: Readonly<Record<string, string> | null | undefined>;
    workspaceRefs: ReadonlyArray<WorkspaceRefV1> | null | undefined;
}>): NormalizedSessionListShellState {
    return {
        collapsedGroupKeys: input.collapsedGroupKeys ?? EMPTY_COLLAPSED_GROUP_KEYS,
        sessionTags: input.sessionTags ?? EMPTY_SESSION_TAGS,
        workspaceLabels: input.workspaceLabels ?? EMPTY_WORKSPACE_LABELS,
        workspaceRefs: input.workspaceRefs ?? EMPTY_WORKSPACE_REFS,
    };
}
