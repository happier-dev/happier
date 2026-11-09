import * as React from 'react';
import { useWindowDimensions, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ImageMarksDocumentV1 } from '@happier-dev/protocol';

import {
    BrowserAnnotatorBar,
    BrowserAnnotatorMount,
    BrowserAnnotatorStage,
    useBrowserAnnotatorStageControl,
    type BrowserAnnotatorSession,
} from '@/components/browser/annotation/BrowserAnnotator';
import { createBrowserAnnotatorElementTool } from '@/components/browser/annotation/browserAnnotatorElementTool';
import type { ImageAnnotator } from '@/components/ui/media/annotation';
import { Text } from '@/components/ui/text/Text';
import { createBrowserAnnotationElementPicker } from '@/sync/domains/browser/context/elementPickerAnnotationBridge';

import { BROWSER_PAGE_ELEMENTS, BROWSER_PAGE_SOURCE } from './screenCaptureFixtures';

const INITIAL: ImageMarksDocumentV1 = {
    v: 1,
    image: { width: BROWSER_PAGE_SOURCE.width, height: BROWSER_PAGE_SOURCE.height, scale: BROWSER_PAGE_SOURCE.scale },
    marks: [],
};

/** `?scene=br`: the real browser annotator over a captured page, with the page's answers as a fixture. */
export function BrowserAnnotateSpecimen() {
    const { width } = useWindowDimensions();
    const { theme } = useUnistyles();
    const phone = width < 600;
    const [document, setDocument] = React.useState(INITIAL);
    const [comment, setComment] = React.useState('');
    const [open, setOpen] = React.useState(true);
    const [annotator, setAnnotator] = React.useState<ImageAnnotator | null>(null);
    const element = React.useMemo(() => {
        return createBrowserAnnotatorElementTool({
            source: BROWSER_PAGE_SOURCE,
            createPicker: (onHover) => createBrowserAnnotationElementPicker({
                scale: BROWSER_PAGE_SOURCE.scale,
                onHover,
                query: async (point) => {
                    const hit = BROWSER_PAGE_ELEMENTS.find(({ rect }) => point.x >= rect.x && point.x <= rect.x + rect.width
                        && point.y >= rect.y && point.y <= rect.y + rect.height);
                    return hit ? { v: 1, pickerRequestId: 'fixture', viewId: 'fixture', navigationGeneration: 1, tier: 'injected', status: 'selected', audited: true,
                        selectorPath: hit.selectorPath, rect: hit.rect, componentName: hit.name } as never : null;
                },
            }),
            recordElement: () => {},
        });
    }, []);
    const session = React.useMemo<BrowserAnnotatorSession | null>(() => (open ? {
        source: BROWSER_PAGE_SOURCE,
        document,
        comment,
        pageLabel: 'Fieldnote — Checkout',
        element,
        onDocumentChange: setDocument,
        onCommentChange: async (next) => setComment(next),
        onAttach: async () => {
            setOpen(false);
            return { ok: true };
        },
        onCancel: () => setOpen(false),
    } : null), [comment, document, element, open]);
    const control = useBrowserAnnotatorStageControl({ annotator, session });
    return (
        <View style={styles.root}>
            {session ? <BrowserAnnotatorMount session={session} onAnnotator={setAnnotator} /> : null}
            {phone ? null : (
                <View style={[styles.session, { borderRightColor: theme.colors.border.default }]}>
                    <Text variant="heading" style={{ color: theme.colors.text.primary }}>Fix checkout total clipping</Text>
                    <Text variant="reading" style={{ color: theme.colors.text.primary }}>Can you send me a screenshot of what you see now? I’d like to check the 1440 layout with your fonts.</Text>
                </View>
            )}
            <View style={styles.pane}>
                <View style={[styles.chrome, { borderBottomColor: theme.colors.border.default }]}>
                    {annotator ? <BrowserAnnotatorBar annotator={annotator} phone={phone} onClose={control.close} attach={control.attach} escapeScope={control.escapeScope} /> : <Text variant="body">localhost:5173/checkout</Text>}
                </View>
                <View style={styles.region} testID="specimen-page-region">
                    {annotator && session ? <BrowserAnnotatorStage annotator={annotator} session={session} phone={phone} control={control} /> : null}
                </View>
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, flexDirection: 'row', backgroundColor: theme.colors.surface.base },
    session: { width: 568, padding: theme.space.s24, gap: theme.space.s12, borderRightWidth: StyleSheet.hairlineWidth },
    pane: { flex: 1, minWidth: 0 },
    chrome: {
        flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, paddingHorizontal: theme.space.s8, paddingVertical: theme.space.s6,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    region: { flex: 1, minHeight: 0, overflow: 'hidden' },
}));
