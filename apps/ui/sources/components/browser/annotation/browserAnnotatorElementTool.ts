import type { ElementPicker, ImageAnnotationSource, PickedElement } from '@/components/ui/media/annotation';
import type {
    BrowserAnnotationElementPicker,
    BrowserAnnotationPickedElement,
} from '@/sync/domains/browser/context/elementPickerAnnotationBridge';

/** A tag names a thing; a page's whole accessible text is not a name. Longer labels end in an ellipsis. */
const ELEMENT_LABEL_MAX_LENGTH = 40;

function fitLabel(label: string): string {
    return label.length > ELEMENT_LABEL_MAX_LENGTH ? `${label.slice(0, ELEMENT_LABEL_MAX_LENGTH - 1)}…` : label;
}

/** Part of an element can lie past the viewport; only what the still shows can carry a mark. */
function clipToPicture(element: BrowserAnnotationPickedElement, source: ImageAnnotationSource): PickedElement | null {
    const x = Math.max(0, element.rect.x);
    const y = Math.max(0, element.rect.y);
    const width = Math.min(source.width, element.rect.x + element.rect.width) - x;
    const height = Math.min(source.height, element.rect.y + element.rect.height) - y;
    if (width <= 0 || height <= 0) return null;
    const size = `${Math.round(element.rect.width / source.scale)} × ${Math.round(element.rect.height / source.scale)}`;
    return {
        rect: { x, y, width, height },
        label: fitLabel(element.label),
        detail: element.role ? `${element.role} · ${size}` : size,
    };
}

/** The Element tool over the page's picker: hover answers become the canvas's box; a pick leaves its facts with the host. */
export function createBrowserAnnotatorElementTool(input: Readonly<{
    source: ImageAnnotationSource;
    createPicker: (onHover: (element: BrowserAnnotationPickedElement | null) => void) => BrowserAnnotationElementPicker;
    recordElement: (markId: string, element: BrowserAnnotationPickedElement) => void;
}>): ElementPicker {
    let listener: ((element: PickedElement | null) => void) | null = null;
    const picker = input.createPicker((element) => listener?.(element && clipToPicture(element, input.source)));
    return {
        activate(onHover) {
            listener = onHover;
            picker.setActive(true);
            return () => {
                picker.setActive(false);
                listener = null;
            };
        },
        hover: picker.hover,
        async pick(point, markId) {
            const element = await picker.pick(point);
            const clipped = element && clipToPicture(element, input.source);
            if (element && clipped) input.recordElement(markId, element);
            return clipped ?? null;
        },
    };
}
