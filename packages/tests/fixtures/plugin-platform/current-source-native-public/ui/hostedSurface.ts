import { createPluginUiRenderContext } from '@happier-dev/plugin-sdk/ui/client';
import { QA_REVISION } from '../revision.js';

const readyId = `qa-current-source-hosted-${QA_REVISION}`;
const historyId = `qa-current-source-hosted-history-${QA_REVISION}`;

function renderCurrentLocation(): void {
  const root = document.querySelector<HTMLElement>('#root');
  if (!root) return;
  if (window.location.hash === '#history') {
    root.replaceChildren(Object.assign(document.createElement('p'), {
      id: historyId,
      textContent: `Current source hosted history ${QA_REVISION}`,
    }));
    return;
  }
  const ready = Object.assign(document.createElement('p'), {
    id: readyId,
    textContent: `Current source hosted ready ${QA_REVISION}`,
  });
  const button = Object.assign(document.createElement('button'), {
    id: 'qa-current-source-hosted-history-action',
    type: 'button',
    textContent: 'Open guest history',
  });
  button.addEventListener('click', () => {
    history.pushState({}, '', '#history');
    renderCurrentLocation();
  });
  root.replaceChildren(ready, button);
}

void createPluginUiRenderContext().then(() => {
  window.addEventListener('popstate', renderCurrentLocation);
  renderCurrentLocation();
});
