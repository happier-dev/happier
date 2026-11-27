import type { SessionRuntimeActivitySnapshot } from '@happier-dev/protocol/sessions/runtime/activity/sessionRuntimeActivity';

export function createLiveWorkPrompt() {
  let acceptedText: string | undefined;
  return (snapshot: SessionRuntimeActivitySnapshot, readMaxUtf8Bytes: () => number) => {
    if (snapshot.state === 'unknown' || (snapshot.state === 'idle' && !snapshot.scheduledWake && !acceptedText)) return null;
    const activity = snapshot.state === 'active'
      ? `${snapshot.activeCount} background ${snapshot.activeCount === 1 ? 'activity is' : 'activities are'} still running.`
      : '';
    const wake = snapshot.scheduledWake ? 'A scheduled wake is pending.' : '';
    const text = `<happier_live_work>${[activity, wake].filter(Boolean).join(' ')
      || 'Background activity has settled. Review any outstanding work before reporting completion.'}</happier_live_work>`;
    if (text === acceptedText || Buffer.byteLength(text, 'utf8') > readMaxUtf8Bytes()) return null;
    return { text, acknowledgeAccepted: () => { acceptedText = text; } };
  };
}
