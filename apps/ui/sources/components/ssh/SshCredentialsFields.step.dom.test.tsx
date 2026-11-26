/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

// Real RNW pressables and the real field select, dropdown and popover owners; only native styling, translations and
// CJS platform adapters cross the test boundary.
vi.mock('react-native', async () =>
  vi.importActual<typeof import('react-native-web')>('react-native-web'),
);
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/utils/web/radixCjs', async () => {
  const { createRadixCjsRealModule } =
    await import('@/dev/testkit/mocks/radixCjs');
  return createRadixCjsRealModule();
});
vi.mock('@/utils/web/reactDomCjs', async () => {
  const dom = await import('react-dom');
  return { requireReactDOM: () => dom };
});
vi.mock('react-native-keyboard-controller', () => ({
  KeyboardAvoidingView: (
    props: React.PropsWithChildren<Record<string, unknown>>,
  ) => React.createElement('div', props),
}));

import {
  SshCredentialsFields,
  type SshCredentialsDraft,
} from './SshCredentialsFields';

function StepForm() {
  const [draft, setDraft] = React.useState<SshCredentialsDraft>({
    username: 'ubuntu',
    host: 'example.test',
    port: '22',
    authMode: 'agent',
    identityFilePath: '',
    password: '',
  });
  const [key, setKey] = React.useState('');
  return (
    <SshCredentialsFields
      testIDPrefix="ssh"
      layoutVariant="step"
      value={draft}
      onChange={setDraft}
      privateKeyMaterial={key}
      onChangePrivateKeyMaterial={setKey}
    />
  );
}

const byTestId = (id: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function choose(mode: 'agent' | 'keyfile' | 'password') {
  await act(async () => {
    byTestId('ssh-sshAuthMethod.trigger')!.click();
  });
  await vi.waitFor(() =>
    expect(byTestId(`ssh-sshAuthMethod:${mode}`)).not.toBeNull(),
  );
  await act(async () => {
    byTestId(`ssh-sshAuthMethod:${mode}`)!.click();
  });
  await vi.waitFor(() =>
    expect(byTestId(`ssh-sshAuthMethod:${mode}`)).toBeNull(),
  );
}

it("picks the way to sign in from one field select whose menu explains each way, and shows only that way's field", async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(<StepForm />);
    });
    // Closed: one field naming the chosen way; no list of ways and no dependent field for the agent.
    expect(byTestId('ssh-sshAuthMethod.trigger')?.textContent).toContain(
      'settings.machineEnrollRemoteSshAgentAuthLabel',
    );
    expect(byTestId('ssh-sshAuthMethod:password')).toBeNull();
    expect(byTestId('ssh-sshPasswordInput')).toBeNull();
    expect(byTestId('ssh-sshIdentityFile')).toBeNull();

    // Open: every way with what it means.
    await act(async () => {
      byTestId('ssh-sshAuthMethod.trigger')!.click();
    });
    await vi.waitFor(() =>
      expect(byTestId('ssh-sshAuthMethod:password')).not.toBeNull(),
    );
    expect(byTestId('ssh-sshAuthMethod:password')!.textContent).toContain(
      'addFlows.sshSignInPassword',
    );
    expect(byTestId('ssh-sshAuthMethod:keyfile')!.textContent).toContain(
      'addFlows.sshSignInKeyFile',
    );
    await act(async () => {
      byTestId('ssh-sshAuthMethod:password')!.click();
    });
    await vi.waitFor(() =>
      expect(byTestId('ssh-sshPasswordInput')).not.toBeNull(),
    );
    expect(byTestId('ssh-sshAuthMethod.trigger')?.textContent).toContain(
      'settings.machineEnrollRemoteSshPasswordAuthLabel',
    );

    await choose('keyfile');
    await vi.waitFor(() =>
      expect(byTestId('ssh-sshIdentityFile')).not.toBeNull(),
    );
    expect(byTestId('ssh-sshPasswordInput')).toBeNull();
    // The key's path leads; pasting a key is a quiet way that opens its field.
    expect(byTestId('ssh-sshPrivateKeyMaterialInput')).toBeNull();
    await act(async () => {
      byTestId('ssh-sshPrivateKeyMaterialOpen')!.click();
    });
    await vi.waitFor(() =>
      expect(byTestId('ssh-sshPrivateKeyMaterialInput')).not.toBeNull(),
    );

    await choose('agent');
    await vi.waitFor(() => expect(byTestId('ssh-sshIdentityFile')).toBeNull());
    expect(byTestId('ssh-sshPasswordInput')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
