export const AUTOMATION_ROWS_PER_CHUNK = 8;

export type AutomationListSegment<T> = Readonly<{
    key: string;
    automations: ReadonlyArray<T>;
    first: boolean;
    last: boolean;
}>;

/**
 * Shared row segmentation for Automation list surfaces. The canonical
 * VirtualizedList remains the scroll/render owner; segments only preserve the
 * incumbent ItemGroup dividers while bounding mounted definitions per row.
 */
export function buildAutomationListSegments<T extends Readonly<{ id: string }>>(
    automations: ReadonlyArray<T>,
): ReadonlyArray<AutomationListSegment<T>> {
    const segments: AutomationListSegment<T>[] = [];
    for (let offset = 0; offset < automations.length; offset += AUTOMATION_ROWS_PER_CHUNK) {
        const chunk = automations.slice(offset, offset + AUTOMATION_ROWS_PER_CHUNK);
        segments.push({
            key: `automations:${chunk[0]!.id}`,
            automations: chunk,
            first: offset === 0,
            last: offset + AUTOMATION_ROWS_PER_CHUNK >= automations.length,
        });
    }
    return segments;
}
