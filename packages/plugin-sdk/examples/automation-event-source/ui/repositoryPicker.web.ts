import { createPluginUiRenderContext } from '@happier-dev/plugin-sdk/ui/client';

async function mount(): Promise<void> {
  const root = document.querySelector<HTMLElement>('#root');
  const input = document.querySelector<HTMLInputElement>('#repository');
  const complete = document.querySelector<HTMLButtonElement>('#complete');
  const cancel = document.querySelector<HTMLButtonElement>('#cancel');
  if (!root || !input || !complete || !cancel) return;

  const context = await createPluginUiRenderContext();
  root.lang = context.surface.locale;
  root.dir = context.surface.direction;
  complete.addEventListener('click', () => {
    const repository = input.value.trim();
    if (!repository) return;
    void context.hostApi.settleEphemeralInput({
      kind: 'completed',
      input: { repository },
    }, { signal: context.signal });
  });
  cancel.addEventListener('click', () => {
    void context.hostApi.settleEphemeralInput({ kind: 'cancelled' }, { signal: context.signal });
  });
}

if (typeof document !== 'undefined') void mount();
