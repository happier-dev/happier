/** Editorial ids belong to one admitted catalog, unlike registry source ids. */
export function storeEditorialGroupKey(sourceId: string, id: string): string {
    return JSON.stringify([sourceId, id]);
}
