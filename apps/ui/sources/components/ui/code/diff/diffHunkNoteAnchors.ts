import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';

/** Content-line anchors shared by Happier's after-line slot and Pierre's annotations. */
export function diffHunkNoteAnchors(unifiedDiff: string, placement: 'column' | 'inline'): ReadonlyMap<string, number> {
    const anchors = new Map<string, number>();
    let hunkIndex = -1;
    let anchor: string | null = null;
    const flush = () => { if (anchor !== null) anchors.set(anchor, hunkIndex); };
    for (const line of buildCodeLinesFromUnifiedDiff({ unifiedDiff, hideFilePrelude: true })) {
        if (line.id.startsWith('h:')) {
            flush();
            hunkIndex += 1;
            anchor = null;
        } else if (hunkIndex >= 0 && (line.oldLine !== null || line.newLine !== null)) {
            if (placement === 'inline' || anchor === null) anchor = line.id;
        }
    }
    flush();
    return anchors;
}
