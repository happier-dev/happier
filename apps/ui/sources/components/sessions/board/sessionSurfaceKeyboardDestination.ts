import type { EntityDropDestination } from '@/components/ui/treeDragDrop';
import { resolveSessionBoardKeyboardAnchor, type SessionBoardAnchoredMove } from './sessionBoardMoveStrategy';

export function resolveSessionSurfaceKeyboardRoute(input: Readonly<{
    intent: 'previous' | 'next' | 'in' | 'out';
    selected: EntityDropDestination | null;
    destinations: readonly EntityDropDestination[];
    sourceTargetId: string;
    resolveLocal?: (intent: 'previous' | 'next' | 'in' | 'out', selected: EntityDropDestination | null, destinations: readonly EntityDropDestination[]) => EntityDropDestination | null;
}>): EntityDropDestination | null {
    const { destinations, selected, intent } = input;
    const group = (destination: EntityDropDestination) => destination.group ?? destination.targetId;
    const origin = input.resolveLocal?.('next', null, destinations) ?? input.resolveLocal?.('previous', null, destinations)
        ?? destinations.find(destination => destination.targetId === input.sourceTargetId) ?? destinations[0];
    const activeGroup = selected ? group(selected) : origin ? group(origin) : null;
    if (intent === 'in' || intent === 'out') {
        const groups = [...new Set(destinations.map(group))];
        const nextGroup = groups[groups.indexOf(activeGroup ?? '') + (intent === 'in' ? 1 : -1)];
        const candidates = destinations.filter(destination => group(destination) === nextGroup);
        return candidates.find(destination => destination.admission.status === 'allowed') ?? candidates[0] ?? null;
    }
    if (input.resolveLocal && (!selected || origin && activeGroup === group(origin))) return input.resolveLocal(intent, selected, destinations);
    const candidates = destinations.filter(destination => group(destination) === activeGroup);
    const index = selected ? candidates.findIndex(candidate => candidate.targetId === selected.targetId && JSON.stringify(candidate.destination) === JSON.stringify(selected.destination)) : -1;
    return candidates[index + (intent === 'previous' ? -1 : 1)] ?? null;
}

export function resolveSessionSurfaceKeyboardDestination(input: Readonly<{
    itemKey: string;
    orderedKeys: readonly string[];
    selected: EntityDropDestination | null;
    destinations: readonly EntityDropDestination[];
    direction: 'previous' | 'next';
    readAnchor(destination: EntityDropDestination): SessionBoardAnchoredMove | null;
}>): EntityDropDestination | null {
    const originalIndex = input.orderedKeys.indexOf(input.itemKey);
    if (originalIndex < 0) return null;
    const without = input.orderedKeys.filter(key => key !== input.itemKey);
    const selectedAnchor = input.selected ? input.readAnchor(input.selected) : null;
    const anchorIndex = selectedAnchor ? without.indexOf(selectedAnchor.itemId) : -1;
    const currentIndex = anchorIndex < 0 ? originalIndex : anchorIndex + (selectedAnchor?.side === 'after' ? 1 : 0);
    const desiredIndex = Math.max(0, Math.min(input.orderedKeys.length - 1, currentIndex + (input.direction === 'previous' ? -1 : 1)));
    const anchor = resolveSessionBoardKeyboardAnchor({ draggedId: input.itemKey, orderedIds: input.orderedKeys, targetPosition: desiredIndex + 1 });
    if (!anchor) return null;
    return input.destinations.find(destination => {
        const candidate = input.readAnchor(destination);
        return candidate?.itemId === anchor.itemId && candidate.side === anchor.side;
    }) ?? null;
}
