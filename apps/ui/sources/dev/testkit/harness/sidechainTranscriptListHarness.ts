export type SidechainTranscriptRendererAxis = Readonly<{
    expectedDataOrder: 'oldest-first';
    expectedHostType: 'LegendList';
    id: string;
    platformOS: 'web' | 'ios';
}>;

export const SIDECHAIN_TRANSCRIPT_RENDERER_AXES: readonly SidechainTranscriptRendererAxis[] = [
    {
        expectedDataOrder: 'oldest-first',
        expectedHostType: 'LegendList',
        id: 'web/legend',
        platformOS: 'web',
    },
    {
        expectedDataOrder: 'oldest-first',
        expectedHostType: 'LegendList',
        id: 'native/legend',
        platformOS: 'ios',
    },
];

export function findSidechainTranscriptRenderer(
    // Renderer props are a third-party boundary shape and intentionally remain open in this test harness.
    screen: Readonly<{ findByType(type: string): { props: Record<string, any> } }>,
    axis: SidechainTranscriptRendererAxis,
) {
    return screen.findByType(axis.expectedHostType);
}
