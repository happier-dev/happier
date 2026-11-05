import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SavedSecretCatalogEntryV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import type { SavedSecretCatalogProjection } from '@/components/secrets/useSavedSecretCatalog';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({ storage: 'real' });

const { ConnectKeySheetBody } = await import('./ConnectKeySheetBody');

function entry(
  overrides: Partial<SavedSecretCatalogEntryV1>,
): SavedSecretCatalogEntryV1 {
  return {
    ref: 'happier:shared-secret:v1:deepseek',
    source: 'shared_resource',
    relationship: 'owner',
    name: 'DeepSeek key',
    kind: 'apiKey',
    encryptionMode: 'e2ee',
    owner: null,
    accessSources: [],
    audience: null,
    ownerAccountId: 'me',
    revision: 1,
    materialStatus: 'ready',
    capabilities: {
      use: true,
      rename: true,
      rotate: true,
      manageAccess: true,
      delete: true,
    },
    ...overrides,
  } as SavedSecretCatalogEntryV1;
}

// The catalog is the body's input (the presenter's one catalog read); only its entries and writers matter here.
function catalog(
  entries: readonly SavedSecretCatalogEntryV1[],
): SavedSecretCatalogProjection {
  return {
    entries,
    sharedEntries: entries,
    sharedEnabled: false,
    personalMutations: {
      create: vi.fn(async () => 'personal:new'),
      rename: vi.fn(),
      rotate: vi.fn(),
      delete: vi.fn(),
    },
    reload: vi.fn(async () => undefined),
  } as unknown as SavedSecretCatalogProjection;
}

const deepseek = entry({});
const shared = entry({
  ref: 'happier:shared-secret:v1:staging',
  name: 'Staging database URL',
  kind: 'other',
  relationship: 'recipient',
  owner: {
    kind: 'account',
    accountId: 'ari',
    name: 'Ari Rahman', username: null,
  } as never,
});

afterEach(async () => {
  await standardCleanup();
});

describe('Connect sheet key body', () => {
  it('opens on the preselected saved key and returns it as selected, without copying it', async () => {
    const onResult = vi.fn();
    const screen = await renderScreen(
      <ConnectKeySheetBody
        catalog={catalog([deepseek, shared])}
        linkableEntries={[deepseek, shared]}
        initialMode="saved"
        preselected={deepseek.ref}
        loading={false}
        scope={null}
        onResult={onResult}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.findHostByTestId('connect-key-sheet:saved')).not.toBeNull();
    expect(screen.findHostByTestId('saved-secret-create-editor')).toBeNull();
    await screen.pressByTestIdAsync('connect-key-sheet:use');
    expect(onResult).toHaveBeenCalledWith({
      kind: 'selected',
      secretRef: deepseek.ref,
    });
  });

  it('lets the person pick another saved key and says when its owner approves first', async () => {
    const onResult = vi.fn();
    const screen = await renderScreen(
      <ConnectKeySheetBody
        catalog={catalog([deepseek, shared])}
        linkableEntries={[deepseek, shared]}
        initialMode="saved"
        preselected={deepseek.ref}
        loading={false}
        scope={null}
        onResult={onResult}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getTextContent()).toContain(
      'connectedServicesSetup.keyOwnerApprovesFirst',
    );
    await screen.pressByTestIdAsync(`connect-key-sheet:saved:${shared.ref}`);
    await screen.pressByTestIdAsync('connect-key-sheet:use');
    expect(onResult).toHaveBeenCalledWith({
      kind: 'selected',
      secretRef: shared.ref,
    });
  });

  it('marks the preselected key, says why the leading rows lead, and drops a kind every row shares', async () => {
    const elsewhere = entry({ ref: 'happier:shared-secret:v1:elsewhere', name: 'DeepSeek work key' });
    const spare = entry({ ref: 'happier:shared-secret:v1:spare', name: 'Spare key' });
    const screen = await renderScreen(
      <ConnectKeySheetBody
        catalog={catalog([deepseek, elsewhere, spare])}
        linkableEntries={[deepseek, elsewhere, spare]}
        initialMode="saved"
        preselected={deepseek.ref}
        currentRef={deepseek.ref}
        sameTargetRefs={[elsewhere.ref]}
        loading={false}
        scope={null}
        onResult={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.findHostByTestId(`connect-key-sheet:selected:${deepseek.ref}`)).not.toBeNull();
    expect(screen.findHostByTestId(`connect-key-sheet:selected:${spare.ref}`)).toBeNull();
    const text = screen.getTextContent();
    expect(text).toContain('connectedServicesSetup.keyInUseHere');
    expect(text).toContain('connectedServicesSetup.keyUsedElsewhereForThis');
    expect(text).not.toContain('secrets.catalog.kinds.apiKey');
    await screen.pressByTestIdAsync(`connect-key-sheet:saved:${spare.ref}`);
    expect(screen.findHostByTestId(`connect-key-sheet:selected:${spare.ref}`)).not.toBeNull();
    expect(screen.findHostByTestId(`connect-key-sheet:selected:${deepseek.ref}`)).toBeNull();
  });

  it('searches a long saved list by name and keeps the choice', async () => {
    const keys = Array.from({ length: 9 }, (_, index) =>
      entry({ ref: `happier:shared-secret:v1:key-${index}`, name: index === 7 ? 'Anthropic team key' : `Key ${index}` }));
    const onResult = vi.fn();
    const screen = await renderScreen(
      <ConnectKeySheetBody
        catalog={catalog(keys)}
        linkableEntries={keys}
        initialMode="saved"
        preselected={null}
        loading={false}
        scope={null}
        onResult={onResult}
        onCancel={vi.fn()}
      />,
    );
    await act(async () => screen.changeTextByTestId('connect-key-sheet:search', 'anthropic'));
    expect(screen.findHostByTestId(`connect-key-sheet:saved:${keys[0]!.ref}`)).toBeNull();
    await screen.pressByTestIdAsync(`connect-key-sheet:saved:${keys[7]!.ref}`);
    await screen.pressByTestIdAsync('connect-key-sheet:use');
    expect(onResult).toHaveBeenCalledWith({ kind: 'selected', secretRef: keys[7]!.ref });
  });

  it('offers only the new-key form when nothing saved can be linked', async () => {
    const screen = await renderScreen(
      <ConnectKeySheetBody
        catalog={catalog([])}
        linkableEntries={[]}
        initialMode="saved"
        preselected={null}
        loading={false}
        scope={null}
        suggestedName="DeepSeek key"
        onResult={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.findHostByTestId('connect-key-sheet:mode:saved')).toBeNull();
    expect(screen.findHostByTestId('saved-secret-create-editor')).not.toBeNull();
    // Name is optional: it shows the suggestion, which the key is saved under unless another is typed.
    expect(screen.findHostByTestId('saved-secret-create-name')!.props.value).toBe('');
    expect(screen.findHostByTestId('saved-secret-create-name')!.props.placeholder).toBe('DeepSeek key');
  });
});
