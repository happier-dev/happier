/** Checkpoint only the exact Project rows the owner has materialized. */
export async function materializeProjectAccountRowPage(
    physicalKeys: readonly string[],
    materializeProjectAccountRows: ((keys: readonly string[]) => Promise<ReadonlySet<string>>) | undefined,
): Promise<ReadonlySet<string>> {
    try {
        if (materializeProjectAccountRows) {
            return await materializeProjectAccountRows(physicalKeys);
        }
    } catch {
        // Leave every key unmaterialized so the existing checkpoint stays below them.
    }
    return new Set();
}
