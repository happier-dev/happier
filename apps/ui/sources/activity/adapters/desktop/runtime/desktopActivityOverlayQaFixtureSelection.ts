import type { DesktopActivityOverlayQaModel, DesktopActivityOverlayQaSeedMode } from './desktopActivityOverlayQaFixtures.mjs';

let selectedMode: DesktopActivityOverlayQaSeedMode | null = null;
let producer: ((model: DesktopActivityOverlayQaModel | null) => void) | null = null;

/** Development MCP seeds publish through the mounted canonical producer. */
export function registerDesktopActivityOverlayQaFixtureProducer(publish: NonNullable<typeof producer>): () => void {
    producer = publish;
    selectedMode = null;
    return () => { if (producer === publish) { producer = null; selectedMode = null; } };
}

export function hasDesktopActivityOverlayQaFixtureProducer(): boolean {
    return producer !== null;
}

export async function selectDesktopActivityOverlayQaFixture(mode: DesktopActivityOverlayQaSeedMode | null): Promise<void> {
    const publish = producer;
    if (!publish || selectedMode === mode) return;
    selectedMode = mode;
    const model = mode ? (await import('./desktopActivityOverlayQaFixtures.mjs')).buildDesktopActivityOverlayQaModel(mode) : null;
    if (producer === publish) publish(model);
}
