import type { ButtonProps, IconButtonProps } from './Button.js';
import { usePluginUiFocusTarget } from '../index.js';
import type { PluginUiFocusTarget } from '../index.js';
import type { FormProps, SelectProps, TextFieldProps } from './Form.js';
import type { HeadingProps, MetadataEntry } from './Foundation.js';
import type { RowProps, ScreenProps, StackProps } from './Layout.js';
import type {
  ItemGroupProps,
  ItemProps,
  ListProps,
  ListSearchProps,
  ListSectionProps,
  ListSelectionProps,
} from './List.js';
import type { MenuGroup, MenuRadioGroup } from './Overlay.js';
import type { StatusProps } from './Status.js';

type Assert<Condition extends true> = Condition;

type IsEqual<Left, Right> = (
  <T>() => T extends Left ? 1 : 2
) extends (
  <T>() => T extends Right ? 1 : 2
) ? true : false;

type _AuthorFormFieldDoesNotExposeHostOptionSources = Assert<
  Extract<
    keyof FormProps['hints']['fields'][number],
    'optionsSourceId' | 'connectedAccountOptions'
  > extends never ? true : false
>;

type _AuthorFocusTargetIsOpaque = Assert<IsEqual<keyof PluginUiFocusTarget, 'focus'>>;
type _AuthorFocusTargetHookIsPublic = Assert<IsEqual<typeof usePluginUiFocusTarget, () => PluginUiFocusTarget>>;

type _AuthorButtonFocusTarget = Assert<IsEqual<ButtonProps['focusTarget'], PluginUiFocusTarget | undefined>>;
type _AuthorIconButtonFocusTarget = Assert<IsEqual<IconButtonProps['focusTarget'], PluginUiFocusTarget | undefined>>;

type _UnnamedIconOnlyButtonIsRejected = Assert<(
  Readonly<{ icon: string; onPress: () => void }> extends ButtonProps ? false : true
)>;
type _NamedIconOnlyButtonIsAccepted = Assert<(
  Readonly<{ icon: string; accessibilityLabel: string; onPress: () => void }> extends ButtonProps ? true : false
)>;
type _VisibleTitleButtonMayUseItsTitleAsTheAccessibleName = Assert<(
  Readonly<{ title: string; icon: string; onPress: () => void }> extends ButtonProps ? true : false
)>;
type _AuthorTextFieldFocusTarget = Assert<IsEqual<TextFieldProps['focusTarget'], PluginUiFocusTarget | undefined>>;
type _AuthorHeadingFocusTarget = Assert<IsEqual<HeadingProps['focusTarget'], PluginUiFocusTarget | undefined>>;
type _AuthorStatusFocusTarget = Assert<IsEqual<StatusProps['focusTarget'], PluginUiFocusTarget | undefined>>;
type _AuthorScreenFocusTarget = Assert<IsEqual<ScreenProps['focusTarget'], PluginUiFocusTarget | undefined>>;
type _AuthorStackFocusTarget = Assert<IsEqual<StackProps['focusTarget'], PluginUiFocusTarget | undefined>>;
type _AuthorRowFocusTarget = Assert<IsEqual<RowProps['focusTarget'], PluginUiFocusTarget | undefined>>;

const authorFocusTarget: PluginUiFocusTarget = {
  focus: () => false,
};

const leakedPhysicalFocusTarget: PluginUiFocusTarget = {
  focus: () => false,
  // @ts-expect-error A plugin target never exposes a node, ref, host, or currentness capability.
  presentationHost: undefined,
};

type _AuthorFormHintKeysAreCurated = Assert<IsEqual<keyof FormProps['hints'],
  | 'title'
  | 'description'
  | 'submitLabel'
  | 'fields'
>>;

type _AuthorFormFieldKeysAreCurated = Assert<IsEqual<keyof FormProps['hints']['fields'][number],
  | 'path'
  | 'title'
  | 'description'
  | 'placeholder'
  | 'widget'
  | 'required'
  | 'requireExplicitSelection'
  | 'listSeparator'
  | 'maxSelections'
  | 'options'
  | 'visibleWhen'
  | 'requiredWhen'
  | 'disabledWhen'
>>;

type AuthorConnectedAccountOptionValue = Extract<
  NonNullable<SelectProps['value']>,
  Readonly<{ accountId: string }>
>;

type _AuthorSelectOptionValueKeysAreCurated = Assert<IsEqual<
  keyof AuthorConnectedAccountOptionValue,
  'service' | 'accountId'
>>;

type _AuthorSelectServiceRefKeysAreCurated = Assert<IsEqual<
  keyof AuthorConnectedAccountOptionValue['service'],
  'pluginId' | 'localId'
>>;

type _AuthorItemPropKeysAreCurated = Assert<IsEqual<keyof ItemProps,
  | 'children'
  | 'title'
  | 'subtitle'
  | 'detail'
  | 'icon'
  | 'accessory'
  | 'tone'
  | 'onPress'
  | 'disabled'
  | 'busy'
  | 'selected'
  | 'accessibilityRole'
  | 'accessibilityExpanded'
  | 'accessibilityPositionInSet'
  | 'accessibilitySetSize'
  | 'density'
  | 'showDivider'
  | 'accessibilityLabel'
  | 'testID'
  | 'style'
  | 'secondaryActions'
  | 'secondaryActionAccessibilityLabel'
  | 'onSecondaryAction'
>>;

type _AuthorListSectionPropKeysAreCurated = Assert<IsEqual<keyof ListSectionProps,
  | 'children'
  | 'title'
  | 'testID'
  | 'style'
>>;

type _AuthorItemGroupPropKeysAreCurated = Assert<IsEqual<keyof ItemGroupProps,
  | 'children'
  | 'accessibilityRole'
  | 'accessibilityLabel'
  | 'testID'
  | 'style'
>>;

type _MetadataEntryKeysAreCurated = Assert<IsEqual<keyof MetadataEntry,
  | 'label'
  | 'value'
  | 'tone'
  | 'accessibilityLabel'
  | 'testID'
>>;

type _MenuGroupKeysAreCurated = Assert<IsEqual<keyof MenuGroup,
  | 'id'
  | 'accessibilityLabel'
  | 'items'
>>;

type _MenuRadioGroupKeysAreCurated = Assert<IsEqual<keyof MenuRadioGroup,
  | 'id'
  | 'accessibilityLabel'
  | 'selectedId'
>>;

const staticAuthorForm: FormProps['hints'] = {
  title: 'Repository settings',
  fields: [{
    path: 'visibility',
    title: 'Visibility',
    widget: 'select',
    options: [
      { value: 'private', label: 'Private' },
      { value: 'public', label: 'Public' },
    ],
  }],
};

const connectedAccountSelect: SelectProps = {
  label: 'Account',
  options: [{
    value: {
      service: { pluginId: 'acme.github', localId: 'hosting' },
      accountId: 'primary',
    },
    label: 'Primary account',
  }],
  onChange: () => undefined,
};

const hostOwnedSelectMetadata: SelectProps = {
  label: 'Account',
  options: [],
  value: {
    service: { pluginId: 'acme.github', localId: 'hosting' },
    accountId: 'primary',
    // @ts-expect-error Host account metadata is not part of an author selection value.
    hostMetadata: { providerId: 'github' },
  },
  onChange: () => undefined,
};

const hostResolvedOptionsSource: FormProps['hints'] = {
  fields: [{
    path: 'account',
    title: 'Account',
    widget: 'select',
    // @ts-expect-error Host option-source resolution is normalized before this author boundary.
    optionsSourceId: 'accounts',
  }],
};

const hostProducedConnectedAccountOptions: FormProps['hints'] = {
  fields: [{
    path: 'account',
    title: 'Account',
    widget: 'select',
    // @ts-expect-error Host account inventory is normalized into public static options.
    connectedAccountOptions: true,
  }],
};

const privateAccessoryPlacement: ItemProps = {
  title: 'Repository',
  // @ts-expect-error The public Item never accepts the private accessory-placement injection.
  accessoryOutsidePressable: undefined,
};

const privateThemeInjection: ItemProps = {
  title: 'Repository',
  // @ts-expect-error The public Item reads theme from PluginUiProvider.
  theme: undefined,
};

const privateTouchTargetInjection: ItemProps = {
  title: 'Repository',
  // @ts-expect-error The host's touch-target floor is not author-controlled.
  minimumTouchTarget: undefined,
};

const privateSecondaryActionState: ItemProps = {
  title: 'Repository',
  // @ts-expect-error Secondary-action state derives from public secondaryActions.
  hasSecondaryActions: undefined,
};

// @ts-expect-error Secondary actions always carry their public selection owner.
const secondaryActionsWithoutSelectionOwner: ItemProps = {
  title: 'Repository',
  secondaryActions: [{ id: 'inspect', label: 'Inspect' }],
};

const privateItemGroupIndex: ItemProps = {
  title: 'Repository',
  // @ts-expect-error ItemGroup owns radio indexing.
  itemGroupRadioIndex: undefined,
};

type AuthorReview = Readonly<{ id: string; title: string }>;

const authorControlledListSearch: ListSearchProps<AuthorReview> = {
  label: 'Search reviews',
  value: '',
  onValueChange: () => undefined,
  filter: (review, query) => review.title.includes(query),
};

const authorControlledListSelection: ListSelectionProps = {
  selectedKey: null,
  onSelectedKeyChange: () => undefined,
};

const authorControlledList: ListProps<AuthorReview> = {
  items: [{ id: 'review-1', title: 'Review current changes' }],
  keyForItem: (review) => review.id,
  renderItem: (review) => review.title,
  search: authorControlledListSearch,
  selection: authorControlledListSelection,
};

// Sections and virtualization are one arm, not two components: the sectioned
// list keeps the same row renderer and reports each row's section key.
const authorSectionedList: ListProps<AuthorReview> = {
  sections: [{ key: 'blocked', title: 'Blocked', data: [{ id: 'review-1', title: 'Review current changes' }] }],
  keyForItem: (review) => review.id,
  renderItem: (review, index, sectionKey: string | null) => `${sectionKey ?? ''}:${index}:${review.title}`,
  selection: authorControlledListSelection,
};

// @ts-expect-error One virtualized arm per List: flat items or labelled sections.
const authorCannotMixListArms: ListProps<AuthorReview> = {
  items: [],
  keyForItem: (review) => review.id,
  renderItem: (review) => review.title,
  sections: [],
};

const privateNativeVirtualizerWindow: ListProps<AuthorReview> = {
  items: [],
  keyForItem: (review) => review.id,
  renderItem: (review) => review.title,
  // @ts-expect-error Native virtualizer calibration stays inside List.
  windowSize: 21,
};

// Keyboard navigation must agree with the rows a reader can actually choose,
// including the ones the virtualizer has not mounted, so the predicate takes the
// author's own item type rather than a rendered row.
const authorSelectionDisabledRows: ListSelectionProps<AuthorReview> = {
  defaultSelectedKey: null,
  isItemDisabled: (review, index) => review.title.length === 0 && index > 0,
};

const privateSelectionRovingProjection: ListSelectionProps<AuthorReview> = {
  defaultSelectedKey: null,
  // @ts-expect-error List owns the roving tab stop; authors never place it.
  tabStopIndex: 0,
};

const privateSelectionFocusInjection: ListSelectionProps = {
  selectedKey: null,
  onSelectedKeyChange: () => undefined,
  // @ts-expect-error Selection exposes a key only, never a host focus ref.
  focusRef: null,
};

void staticAuthorForm;
void connectedAccountSelect;
void hostOwnedSelectMetadata;
void hostResolvedOptionsSource;
void hostProducedConnectedAccountOptions;
void privateAccessoryPlacement;
void privateThemeInjection;
void privateTouchTargetInjection;
void privateSecondaryActionState;
void secondaryActionsWithoutSelectionOwner;
void privateItemGroupIndex;
void authorControlledList;
void authorSectionedList;
void authorCannotMixListArms;
void privateNativeVirtualizerWindow;
void authorSelectionDisabledRows;
void privateSelectionRovingProjection;
void privateSelectionFocusInjection;
void authorFocusTarget;
void leakedPhysicalFocusTarget;
