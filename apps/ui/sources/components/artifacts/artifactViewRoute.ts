/** A Doc's view; `thread` opens it at that passage thread. */
export function artifactViewRoute(artifactId: string, anchor?: Readonly<{ thread: string }>): string {
    const path = `/artifacts/${encodeURIComponent(artifactId)}`;
    return anchor ? `${path}?thread=${encodeURIComponent(anchor.thread)}` : path;
}
