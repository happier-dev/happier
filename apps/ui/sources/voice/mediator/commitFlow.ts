export async function runVoiceMediatorCommitFlow(opts: {
    isActive: () => boolean;
    commit: () => Promise<string>;
    confirmSend: (previewText: string) => Promise<boolean>;
    applyToComposer: (text: string) => void;
    sendToSession: (text: string) => Promise<void>;
    alert: (title: string, message: string) => Promise<void>;
    notActiveTitle?: string;
    notActiveMessage?: string;
}): Promise<void> {
    if (!opts.isActive()) {
        await opts.alert(opts.notActiveTitle ?? 'Error', opts.notActiveMessage ?? 'Mediator not active');
        return;
    }

    let commitText: string;
    try {
        commitText = await opts.commit();
    } catch (e) {
        await opts.alert('Error', e instanceof Error ? e.message : 'Failed to commit');
        return;
    }

    opts.applyToComposer(commitText);

    const shouldSend = await opts.confirmSend(commitText);
    if (!shouldSend) return;

    try {
        await opts.sendToSession(commitText);
    } catch (e) {
        await opts.alert('Error', e instanceof Error ? e.message : 'Failed to send');
    }
}
