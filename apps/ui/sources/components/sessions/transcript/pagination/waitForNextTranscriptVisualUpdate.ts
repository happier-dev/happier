export async function waitForNextTranscriptVisualUpdate(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();

    const requestAnimationFrameMaybe = globalThis.requestAnimationFrame;
    if (typeof requestAnimationFrameMaybe !== 'function') return;

    await new Promise<void>((resolve) => {
        requestAnimationFrameMaybe(() => resolve());
    });
}
