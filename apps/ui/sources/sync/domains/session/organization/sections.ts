import {
    projectSessionSectionV1,
    compareSessionSectionOrderV1,
    type QualifiedSessionSectionV1,
    type SessionSectionV1,
    QualifiedSessionSectionV1Schema,
} from '@happier-dev/protocol/sessions/organization/folders';

import { buildSessionOrganizationServerKey, buildSessionOrganizationSessionKey } from './keys';
import type { SessionOrganizationProjection } from './types';
import type { SessionFolderWorkspaceRefV1 } from '../folders/types';
import { buildSessionFolderWorkspaceRefKey, normalizeSessionFolderWorkspaceRef } from '../folders/workspaceRefs';
import { formatSessionPath } from '@/utils/sessions/formatPathRelativeToHome';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { buildSessionFolderAssignmentKey } from '../folders/assignmentKeys';
import { t } from '@/text';

export type SectionAddress = QualifiedSessionSectionV1;
export type SessionSectionLegacyContext = Readonly<{
    ancestors: readonly Readonly<{ address: SectionAddress; display: SessionSectionV1['displayState'] | null }>[];
    /** Retained display context only, never execution placement or eligibility. */
    workspace: SessionFolderWorkspaceRefV1 | null;
}>;
export type SessionSection = Readonly<{
    address: SectionAddress;
    display: SessionSectionV1['displayState'];
    sortKey: string | null;
    legacyContext?: SessionSectionLegacyContext;
}>;

export function buildSessionSectionGroupKey(address: SectionAddress): string {
    return JSON.stringify(['session-section', address.serverId, address.sectionId]);
}

/** One codec for current and proven predecessor scopes; workspace members stay opaque. */
function readSessionSectionScope(scopeKey: string): Readonly<{ legacy: boolean; serverId: string; sectionId: string | null }> | null {
    let value: unknown;
    try { value = JSON.parse(scopeKey); } catch { return null; }
    if (!Array.isArray(value)) return null;
    const legacy = value.length === 4 && value[0] === 'folder-group' && typeof value[2] === 'string';
    const current = value.length === 3 && value[0] === 'session-section';
    if (!legacy && !current) return null;
    const sectionId = value[legacy ? 3 : 2];
    if (legacy && sectionId === null) {
        const home = QualifiedSessionSectionV1Schema.shape.serverId.safeParse(value[1]);
        return home.success ? { legacy, serverId: home.data, sectionId: null } : null;
    }
    const address = QualifiedSessionSectionV1Schema.safeParse({ serverId: value[1], sectionId });
    return address.success ? { legacy, ...address.data } : null;
}

export function readSessionSectionGroupAddress(scopeKey: string): SectionAddress | null {
    const scope = readSessionSectionScope(scopeKey);
    return scope && !scope.legacy && scope.sectionId !== null ? { serverId: scope.serverId, sectionId: scope.sectionId } : null;
}

export function readLegacySessionFolderGroupScope(scopeKey: string): Readonly<{ serverId: string; sectionId: string | null }> | null {
    const scope = readSessionSectionScope(scopeKey);
    return scope?.legacy ? { serverId: scope.serverId, sectionId: scope.sectionId } : null;
}

export function readLegacySessionSectionGroupAddress(scopeKey: string): SectionAddress | null {
    const scope = readLegacySessionFolderGroupScope(scopeKey);
    return scope && scope.sectionId !== null ? { serverId: scope.serverId, sectionId: scope.sectionId } : null;
}

/** Flat Account filing only. Pins, eligible lead nesting and attention remain downstream. */
export function projectSessionSectionListIndex(params: Readonly<{
    source: ReadonlyArray<SessionListIndexItem>;
    sections: readonly SessionSection[];
    assignmentsBySessionKey: Readonly<Record<string, string | null | undefined>>;
}>): Readonly<{ items: ReadonlyArray<SessionListIndexItem> }> {
    const sectionsByKey = new Map(params.sections.map(section => [buildSessionOrganizationServerKey(
        section.address.serverId, section.address.sectionId,
    ), section]));
    const members = new Map<string, SessionListIndexItem[]>();
    const remainder: SessionListIndexItem[] = [];
    let changed = params.sections.length > 0;
    for (const item of params.source) {
        if (item.type !== 'session') {
            remainder.push(item);
            continue;
        }
        const folderId = params.assignmentsBySessionKey[buildSessionFolderAssignmentKey(
            item.serverId, item.sessionId, item.keyParts,
        )] ?? null;
        const annotated = (item.folderId ?? null) === folderId ? item : { ...item, folderId };
        const section = folderId && item.serverId ? sectionsByKey.get(buildSessionOrganizationServerKey(item.serverId, folderId)) : undefined;
        if (!section) {
            remainder.push(annotated);
            changed ||= annotated !== item;
            continue;
        }
        const groupKey = buildSessionSectionGroupKey(section.address);
        const rows = members.get(groupKey) ?? [];
        rows.push({ ...annotated, groupKey, groupKind: 'folder', folderDepth: 1 });
        members.set(groupKey, rows);
        changed = true;
    }
    if (!changed) return { items: params.source };
    const items: SessionListIndexItem[] = [];
    for (const section of params.sections) {
        const groupKey = buildSessionSectionGroupKey(section.address);
        items.push({ type: 'header', headerKind: 'folder', groupKey,
            serverId: section.address.serverId, folderId: section.address.sectionId, folderDepth: 0,
            title: section.display.status === 'available' ? section.display.value.name : '',
            displayState: section.display.status === 'available'
                ? { status: 'available', value: section.display.value.name } : section.display,
        });
        items.push(...(members.get(groupKey) ?? []));
    }
    items.push(...remainder);
    return { items };
}

/** A state label when private display is unavailable, never a replacement stored name. */
export function resolveSessionSectionDisplayTitle(display: SessionSection['display']): string {
    if (display.status === 'available') return display.value.name;
    return display.reason === 'account_key_unavailable' ? t('sessionsList.lockedSection') : t('sessionsList.unavailableSection');
}

/** One label projection for every controlled section chooser, including legacy disambiguation. */
export function resolveSessionSectionChoiceLabel(section: SessionSection, options: Readonly<{
    unavailableLabel: string;
    /** Already-held, opened display metadata only. A null value explicitly means unavailable. */
    workspaceDisplayByKey?: Readonly<Record<string, string | null>>;
}>): Readonly<{ title: string; contextLabel: string | null; choiceLabel: string }> {
    const title = resolveSessionSectionDisplayTitle(section.display);
    const context: string[] = [];
    const legacy = section.legacyContext;
    if (legacy?.workspace) {
        const key = buildSessionFolderWorkspaceRefKey(legacy.workspace);
        const held = options.workspaceDisplayByKey;
        const label = held && Object.prototype.hasOwnProperty.call(held, key)
            ? held[key]?.trim() || options.unavailableLabel
            : legacy.workspace.t === 'workspaceScope'
                ? formatSessionPath(legacy.workspace.rootPath)
                : options.unavailableLabel;
        context.push(label);
    }
    if (legacy?.ancestors.length) {
        context.push(legacy.ancestors.map(ancestor => ancestor.display
            ? resolveSessionSectionDisplayTitle(ancestor.display) : t('sessionsList.unavailableSection')).join(' / '));
    }
    const contextLabel = context.length ? context.join(' · ') : null;
    return { title, contextLabel, choiceLabel: contextLabel ? `${title} — ${contextLabel}` : title };
}

/**
 * Labels for one chooser's choices, keyed by section id: a section is named plainly, and gains its legacy
 * context only where another choice shares its name (the disambiguation P5 asks for, not a suffix on every row).
 */
export function resolveSessionSectionChoiceLabels(
    sections: readonly SessionSection[],
    options: Parameters<typeof resolveSessionSectionChoiceLabel>[1],
): ReadonlyMap<string, string> {
    const resolved = sections.map(section => [section.address.sectionId, resolveSessionSectionChoiceLabel(section, options)] as const);
    const nameKey = (title: string) => title.trim().toLocaleLowerCase();
    const counts = new Map<string, number>();
    for (const [, label] of resolved) counts.set(nameKey(label.title), (counts.get(nameKey(label.title)) ?? 0) + 1);
    return new Map(resolved.map(([sectionId, label]) => [sectionId,
        (counts.get(nameKey(label.title)) ?? 0) > 1 ? label.choiceLabel : label.title]));
}

/** Product projection of the incumbent opened folder records, with no workspace eligibility rule. */
export function projectSessionOrganizationSections(
    serverId: string,
    projection: Pick<SessionOrganizationProjection, 'foldersById'>,
): SessionSection[] {
    const folders = Object.values(projection.foldersById).filter(folder => folder.archivedAt === null);
    const sectionsById = new Map(folders.map(folder => [folder.folderId, projectSessionSectionV1(folder)]));
    return folders.map(folder => {
        const section = sectionsById.get(folder.folderId)!;
        const ancestors: Array<SessionSectionLegacyContext['ancestors'][number]> = [];
        const visited = new Set([folder.folderId]);
        let parentId = folder.parentFolderId;
        // Legacy parent graphs may be partial. Do not recover an unavailable parent's name
        // from its raw envelope or walk a retained cycle indefinitely.
        while (parentId && !visited.has(parentId)) {
            visited.add(parentId);
            const parent = sectionsById.get(parentId);
            ancestors.push({ address: { serverId, sectionId: parentId }, display: parent?.displayState ?? null });
            if (!parent) break;
            parentId = projection.foldersById[parentId]?.parentFolderId ?? null;
        }
        ancestors.reverse();
        const value = section.displayState.status === 'available' && folder.displayState.status === 'available'
            ? folder.displayState.value ?? (folder.display?.t === 'plain' ? folder.display.v : null) : null;
        const workspace = normalizeSessionFolderWorkspaceRef(value && typeof value === 'object' && !Array.isArray(value)
            && 'workspace' in value ? value.workspace : null);
        return {
            address: { serverId, sectionId: section.sectionId },
            display: section.displayState,
            sortKey: section.sortKey,
            ...(ancestors.length > 0 || workspace ? { legacyContext: { ancestors, workspace } } : {}),
        };
    }).sort((left, right) => compareSessionSectionOrderV1(
        { sectionId: left.address.sectionId, sortKey: left.sortKey },
        { sectionId: right.address.sectionId, sortKey: right.sortKey },
    ));
}

/** Assignment membership ignores loaded bodies/tree placement; coverage is carried separately. */
export function projectSessionSectionMembership(
    serverId: string,
    projection: SessionOrganizationProjection,
): Record<string, readonly string[]> {
    const membership: Record<string, string[]> = {};
    for (const folder of Object.values(projection.foldersById)) {
        if (folder.archivedAt === null) membership[buildSessionOrganizationServerKey(serverId, folder.folderId)] = [];
    }
    for (const [sessionId, folderId] of Object.entries(projection.folderAssignmentsBySessionId)) {
        if (folderId === null) continue;
        const key = buildSessionOrganizationServerKey(serverId, folderId);
        (membership[key] ??= []).push(buildSessionOrganizationSessionKey(serverId, sessionId));
    }
    return membership;
}
