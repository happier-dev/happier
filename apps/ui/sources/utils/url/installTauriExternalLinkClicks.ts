import { openExternalUrl } from './openExternalUrl';
import { requestOpenExternalUrl } from './requestOpenExternalUrl';

export function installTauriExternalLinkClicks(): () => void {
  const originalOpen = window.open;
  window.open = (url, target, features) => {
    const value = String(url ?? '');
    if (/^https?:\/\//i.test(value)) {
      // This shim is RN Web's platform transport, including admitted auth continuations.
      // Explicit controls enter the Action before reaching the platform opener.
      void openExternalUrl(value);
      return null;
    }
    return originalOpen.call(window, url, target, features);
  };
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a[href]');
    if (!(anchor instanceof HTMLAnchorElement) || anchor.target !== '_blank') return;
    if (!/^https?:\/\//i.test(anchor.href)) return;
    event.preventDefault();
    void requestOpenExternalUrl(anchor.href);
  };
  document.addEventListener('click', onClick);
  return () => {
    document.removeEventListener('click', onClick);
    window.open = originalOpen;
  };
}
