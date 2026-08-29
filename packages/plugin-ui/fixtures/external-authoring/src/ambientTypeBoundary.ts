import type {
  FormProps,
  ItemGroupProps,
  ItemProps,
  ListSectionProps,
  SelectProps,
} from '@happier-dev/plugin-ui';

// The exact consumer installs @types/node for package-owned tooling and SDK
// module references, but browser/native author source must not gain its globals.
// @ts-expect-error NodeJS must stay absent from the author compiler lanes.
type NodeAmbientMustStayUnavailable = NodeJS.ProcessEnv;

const authorHints: FormProps['hints'] = {
  fields: [{
    path: 'repository.visibility',
    title: 'Visibility',
    widget: 'select',
    options: [
      { value: 'private', label: 'Private' },
      { value: 'public', label: 'Public' },
    ],
  }],
};

const authorSelect: SelectProps = {
  label: 'Connected account',
  options: [{
    value: {
      service: { pluginId: 'acme.hosting', localId: 'github' },
      accountId: 'primary',
    },
    label: 'Primary account',
  }],
  onChange: () => undefined,
};

const hostOwnedSelectMetadata: SelectProps = {
  label: 'Connected account',
  options: [],
  value: {
    service: { pluginId: 'acme.hosting', localId: 'github' },
    accountId: 'primary',
    // @ts-expect-error Account inventory metadata is normalized before author props.
    hostMetadata: { providerId: 'github' },
  },
  onChange: () => undefined,
};

const authorListSection: ListSectionProps = { title: 'Repositories' };
const authorItemGroup: ItemGroupProps = { accessibilityLabel: 'Repository actions' };
const authorItem: ItemProps = { title: 'happier' };

const hostResolvedOptionsSource: FormProps['hints'] = {
  fields: [{
    path: 'repository.account',
    title: 'Account',
    widget: 'select',
    // @ts-expect-error A host resolver must normalize its current options before author props.
    optionsSourceId: 'connected-accounts',
  }],
};

const hostProducedConnectedAccountOptions: FormProps['hints'] = {
  fields: [{
    path: 'repository.account',
    title: 'Account',
    widget: 'select',
    // @ts-expect-error Host account inventory never becomes an author-controlled prop.
    connectedAccountOptions: true,
  }],
};

const independentAccessoryPlacement: ItemProps = {
  title: 'happier',
  accessoryOutsidePressable: true,
};

const privateThemeInjection: ItemProps = {
  title: 'happier',
  // @ts-expect-error Theme is injected from the mounted PluginUiProvider.
  theme: {},
};

const privateTouchTargetInjection: ItemProps = {
  title: 'happier',
  // @ts-expect-error The host owns the native touch-target floor.
  minimumTouchTarget: 44,
};

const privateSecondaryActionState: ItemProps = {
  title: 'happier',
  // @ts-expect-error Secondary-action state derives from public author actions.
  hasSecondaryActions: true,
};

const privateItemGroupIndex: ItemProps = {
  title: 'happier',
  // @ts-expect-error ItemGroup owns radio index projection.
  itemGroupRadioIndex: 0,
};

void authorHints;
void authorSelect;
void hostOwnedSelectMetadata;
void authorListSection;
void authorItemGroup;
void authorItem;
void hostResolvedOptionsSource;
void hostProducedConnectedAccountOptions;
void independentAccessoryPlacement;
void privateThemeInjection;
void privateTouchTargetInjection;
void privateSecondaryActionState;
void privateItemGroupIndex;

export {};
