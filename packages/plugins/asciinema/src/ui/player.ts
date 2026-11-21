import { create } from 'asciinema-player';
import 'asciinema-player/dist/bundle/asciinema-player.css';
import { createPluginUiRenderContext } from '@happier-dev/plugin-sdk/ui/client';
import { readRecording, recordingReference } from './recording.js';

async function mount(): Promise<void> {
    const status = document.getElementById('status');
    const root = document.getElementById('player');
    const retry = document.getElementById('retry');
    if (!status || !root || !(retry instanceof HTMLButtonElement)) return;
    const context = await createPluginUiRenderContext();
    const ref = recordingReference(context.launchInput);
    if (!ref) { status.textContent = 'Open a .cast file and choose Asciinema to play it.'; return; }
    let player: ReturnType<typeof create> | undefined;
    context.signal.addEventListener('abort', () => player?.dispose(), { once: true });
    const load = async () => {
        retry.disabled = true;
        player?.dispose();
        player = undefined;
        status.hidden = false;
        status.textContent = 'Loading recording…';
        try {
            const result = await readRecording(context.hostApi, ref, context.signal);
            if (context.signal.aborted) return;
            if (result.status === 'ready') {
                player = create({ data: result.text, parser: 'asciicast' }, root, { preload: true, autoPlay: false, fit: 'width' });
                status.hidden = true;
            } else {
                const messages = {
                    invalid: 'This is not a valid asciicast v2 or v3 recording. Choose the text viewer to inspect it.',
                    tooLarge: 'This recording exceeds the viewer’s 10 MB limit. Choose the text viewer to inspect it.',
                    changed: 'The file changed while loading. Reload to read the current recording.',
                    unavailable: 'This recording is unavailable. Reload to try again.',
                    unsupported: 'Playback is unavailable here. Choose the built-in text viewer.',
                    cancelled: 'Loading was cancelled. Reload to try again.',
                };
                status.textContent = messages[result.status];
            }
        } catch {
            if (!context.signal.aborted) status.textContent = 'The recording could not be loaded. Reload or choose the text viewer.';
        } finally {
            retry.hidden = false;
            retry.disabled = false;
        }
    };
    retry.addEventListener('click', () => { void load(); }, { signal: context.signal });
    await load();
}

if (typeof document !== 'undefined') {
    void mount().catch(() => {
        const status = document.getElementById('status');
        if (status) status.textContent = 'Playback is unavailable here. Choose the built-in text viewer.';
    });
}
