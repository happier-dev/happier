import { samePluginUiMaterializationFacts } from './projection';
import type { PluginUiProjectionModel } from './projection';
import type { PluginUiProjectionUnionMember, UnionSourceModelIndex } from './projectionUnion';

export function unionMemberKey(member: PluginUiProjectionUnionMember): string {
    // Length-prefixing preserves punctuation and absent identity distinctions.
    return [member.machineId, member.serverId, member.serverIdentityId]
        .map(value => typeof value === 'string' ? `${value.length}:${value}` : String(value)).join('/');
}

/** Source publications name changed plugins once instead of rescanning the fleet per plugin. */
export function collectPluginUnionChanges(previousMembers: readonly PluginUiProjectionUnionMember[],
    members: readonly PluginUiProjectionUnionMember[],
    previousIndexes: ReadonlyMap<PluginUiProjectionModel, UnionSourceModelIndex> | undefined,
    indexes: ReadonlyMap<PluginUiProjectionModel, UnionSourceModelIndex>,
    hasActivationRefusal: (member: PluginUiProjectionUnionMember, pluginId: string) => boolean) {
    const previous = new Map(previousMembers.map(member => [unionMemberKey(member), member]));
    const declarations = new Set<string>();
    const availability = new Set<string>();
    const visit = (before: PluginUiProjectionUnionMember | undefined, after: PluginUiProjectionUnionMember | undefined) => {
        if (before === after) return;
        const left = before?.projection ? previousIndexes?.get(before.projection) : undefined;
        const right = after?.projection ? indexes.get(after.projection) : undefined;
        const coverageChanged = before?.currentPresentationSections !== after?.currentPresentationSections;
        // A picture's order is its position in the member dictionary; derive it only when that dictionary was replaced.
        let picturePositions: readonly [ReadonlyMap<string, number>, ReadonlyMap<string, number>] | undefined;
        const picturesReordered = (ids: ReadonlySet<string> | undefined): boolean => {
            const leftPictures = before?.projection?.atmospherePicturesById;
            const rightPictures = after?.projection?.atmospherePicturesById;
            if (!ids?.size || !leftPictures || !rightPictures || leftPictures === rightPictures) return false;
            const [leftPositions, rightPositions] = picturePositions ??= [readPicturePositions(leftPictures), readPicturePositions(rightPictures)];
            return [...ids].some(key => leftPositions.get(key) !== rightPositions.get(key));
        };
        for (const id of new Set([...left?.keysByPlugin.keys() ?? [], ...right?.keysByPlugin.keys() ?? []])) {
            const contributes = (index: UnionSourceModelIndex | undefined) => [...index?.keysByPlugin.get(id) ?? []]
                .some(([key, ids]) => key !== 'installedPackagesById' && ids.size > 0);
            if (!contributes(left) && !contributes(right)) {
                if (coverageChanged) availability.add(id);
                continue;
            }
            if (!before || !after || !left || !right
                || left.publicationIndex.slices[id] !== right.publicationIndex.slices[id]
                || !samePluginUiMaterializationFacts(before.materializationsByPluginId?.[id], after.materializationsByPluginId?.[id])) {
                declarations.add(id); availability.add(id); continue;
            }
            if (coverageChanged || before.phase !== after.phase || before.interactionEnabled !== after.interactionEnabled
                || before.unavailableReasonCode !== after.unavailableReasonCode
                || (before.projection!.generation === null) !== (after.projection!.generation === null)
                || (before.projection!.diagnostics !== after.projection!.diagnostics
                    && hasActivationRefusal(before, id) !== hasActivationRefusal(after, id))
                || picturesReordered(left.keysByPlugin.get(id)?.get('atmospherePicturesById'))) availability.add(id);
        }
    };
    for (const member of members) {
        const key = unionMemberKey(member);
        visit(previous.get(key), member);
        previous.delete(key);
    }
    for (const member of previous.values()) visit(member, undefined);
    return { declarations, availability };
}

function readPicturePositions(pictures: Readonly<Record<string, unknown>>): ReadonlyMap<string, number> {
    return new Map(Object.keys(pictures).map((key, position) => [key, position]));
}
