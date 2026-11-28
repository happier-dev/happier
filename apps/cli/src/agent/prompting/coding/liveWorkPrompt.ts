import type { SessionRuntimeActivitySnapshot } from '@happier-dev/protocol/sessions/runtime/activity/sessionRuntimeActivity';

export function createLiveWorkPrompt() {
  let acceptedText: string | undefined;
  return (snapshot: SessionRuntimeActivitySnapshot | undefined, readMaxUtf8Bytes: () => number,
    { questionCount = 0, activeItemCount = 0 }: Readonly<{ questionCount?: number; activeItemCount?: number }> = {}) => {
    const activity = snapshot?.state === 'active'
      ? `${snapshot.activeCount} background ${snapshot.activeCount === 1 ? 'activity is' : 'activities are'} still running.`
      : '';
    const wake = snapshot?.scheduledWake ? 'A scheduled wake is pending.' : '';
    const questions = questionCount > 0 ? `${questionCount} Needs you ${questionCount === 1 ? 'question is' : 'questions are'} still open.` : '';
    const items = activeItemCount > 0 ? `${activeItemCount} work ${activeItemCount === 1 ? 'item is' : 'items are'} in progress.` : '';
    const work = [activity, wake, questions, items].filter(Boolean).join(' ');
    if (!work && (snapshot?.state !== 'idle' || !acceptedText)) return null;
    const text = `<happier_live_work>${work
      || 'Background activity has settled. Review any outstanding work before reporting completion.'}</happier_live_work>`;
    if (text === acceptedText || Buffer.byteLength(text, 'utf8') > readMaxUtf8Bytes()) return null;
    return { text, acknowledgeAccepted: () => { acceptedText = text; } };
  };
}
