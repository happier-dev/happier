import type { IconName } from '@/components/ui/icons/Icon';
import type { SelectionListOption } from '@/components/ui/selectionList';
import { sameQueryMarks } from '@/components/ui/text/queryRanges';

import type { UniversalSearchResult, UniversalSearchTarget } from './universalSearchResult';

const projection = Symbol('universalSearchOptionProjection');

type OptionInputs = Readonly<{
    result: UniversalSearchResult;
    iconName: IconName;
    onCommit: (result: UniversalSearchResult) => void;
    fileLine: unknown;
    titleQuery: string | undefined;
}>;
type ProjectedOption = SelectionListOption & Readonly<{ [projection]?: OptionInputs }>;

export function hasUniversalSearchOptionProjection(option: SelectionListOption): boolean {
    return (option as ProjectedOption)[projection] !== undefined;
}

function sameTarget(left: UniversalSearchTarget, right: UniversalSearchTarget): boolean {
    if (left === right) return true;
    if (left.kind !== right.kind) return false;
    switch (left.kind) {
        case 'settingsPage':
            return right.kind === 'settingsPage' && left.route === right.route;
        case 'session':
            return right.kind === 'session' && left.sessionId === right.sessionId && left.serverId === right.serverId
                && left.accountId === right.accountId && left.seq === right.seq && left.find === right.find;
        case 'project':
            return right.kind === 'project' && left.workspaceRefId === right.workspaceRefId && left.serverId === right.serverId
                && left.accountId === right.accountId && left.machineId === right.machineId && left.rootPath === right.rootPath;
        case 'workspaceFile':
            return right.kind === 'workspaceFile' && left.scope === right.scope && left.path === right.path
                && left.anchor === right.anchor && left.anchorSource === right.anchorSource && left.find === right.find
                && left.workspaceRefId === right.workspaceRefId && left.sessionId === right.sessionId
                && left.serverId === right.serverId && left.accountId === right.accountId;
        default:
            // Rich remote hits carry query-specific evidence and navigation; only their producer can retain it.
            return false;
    }
}

function sameResult(left: UniversalSearchResult, right: UniversalSearchResult): boolean {
    return left === right || (left.id === right.id && left.scopeKey === right.scopeKey && left.sourceId === right.sourceId
        && left.kind === right.kind && left.title === right.title && left.subtitle === right.subtitle
        && left.searchText === right.searchText && left.exactSearchText === right.exactSearchText
        && left.symbol === right.symbol && left.fileContent === right.fileContent
        && left.conversation === right.conversation && left.fileChange === right.fileChange && left.agentId === right.agentId
        && sameTarget(left.target, right.target));
}


/**
 * Reconcile at the option producer against its current output, before constructing any visuals or callbacks.
 * The inputs travel with that output (already retained by its activation closure); there is no second cache.
 */
export function projectUniversalSearchOption(
    previous: SelectionListOption | undefined,
    inputs: OptionInputs,
    build: () => SelectionListOption,
): SelectionListOption {
    const before = (previous as ProjectedOption | undefined)?.[projection];
    if (previous && before && before.iconName === inputs.iconName && before.onCommit === inputs.onCommit
        && before.fileLine === inputs.fileLine && sameResult(before.result, inputs.result)
        && sameQueryMarks(previous.label, before.titleQuery, inputs.titleQuery)) return previous;
    return Object.assign(build(), { [projection]: inputs });
}
