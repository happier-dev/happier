# Plugin UI public declaration report

> Generated from prepared package declarations. Do not hand-edit.
> Records the normalized declaration behind every published export, plus the
> declarations those signatures reach, so no signature this package ships can
> change without a reviewable diff. Implementation bodies, initializers, private
> class members and comments are omitted; inferred value and return types are
> materialized.
> Every published export and reachable declaration physically beneath a
> `bundledDependencies` package is recorded in full, including nested bundled
> dependencies, because this tarball vendors it and nothing else will publish it.
> A declaration reached only through a signature and resolved outside that bundled
> payload is recorded as a named edge, because the consumer resolves and versions
> that package independently.
> Whether a difference is breaking or additive stays a publishing decision.

## Published exports

### `.` — `Action` (value)

Declared by `dist/components/Action.d.ts` as `Action`.

```ts
const Action: Readonly<{
    Execute: typeof ActionExecute;
    Copy: typeof ActionCopy;
    OpenExternal: typeof ActionOpenExternal;
    OpenSurface: typeof ActionOpenSurface;
    Refresh: typeof ActionRefresh;
}>;
```


### `.` — `ActionCopyProps` (type)

Declared by `dist/components/Action.d.ts` as `ActionCopyProps`.

```ts
type ActionCopyProps = ActionChromeProps & Readonly<{
    value: string;
}>;
```


### `.` — `ActionExecuteProps` (type)

Declared by `dist/components/Action.d.ts` as `ActionExecuteProps`.

```ts
type ActionExecuteProps<TAction extends PluginUiActionReference = PluginUiActionReference> = ActionChromeProps & Readonly<{
    action: TAction;
    input?: NoInfer<PluginUiActionInputFor<NoInfer<TAction>>>;
    onSettled?: (execution: PluginActionExecution<PluginUiActionResultFor<NoInfer<TAction>>>) => void;
}>;
```


### `.` — `ActionFormFieldHint` (type)

Re-exported from another package as `ActionFormFieldHint`; that package owns the declaration.

```ts
// declared by another package — see its own declaration report
```


### `.` — `ActionFormHints` (type)

Re-exported from another package as `ActionFormHints`; that package owns the declaration.

```ts
// declared by another package — see its own declaration report
```


### `.` — `ActionOpenExternalProps` (type)

Declared by `dist/components/Action.d.ts` as `ActionOpenExternalProps`.

```ts
type ActionOpenExternalProps = ActionChromeProps & Readonly<{
    url: string;
}>;
```


### `.` — `ActionOpenSurfaceProps` (type)

Declared by `dist/components/Action.d.ts` as `ActionOpenSurfaceProps`.

```ts
type ActionOpenSurfaceProps = ActionChromeProps & Readonly<{
    view: PluginReference;
    input?: JsonValue;
}>;
```


### `.` — `ActionPanel` (value)

Declared by `dist/components/Action.d.ts` as `ActionPanel`.

```ts
const ActionPanel: typeof ActionPanelRoot & {
    Section: typeof ActionPanelSection;
};
```


### `.` — `ActionPanelProps` (type)

Declared by `dist/components/Action.d.ts` as `ActionPanelProps`.

```ts
type ActionPanelProps = ActionGroupProps;
```


### `.` — `ActionPanelSectionProps` (type)

Declared by `dist/components/Action.d.ts` as `ActionPanelSectionProps`.

```ts
type ActionPanelSectionProps = ActionGroupProps;
```


### `.` — `ActionRefreshProps` (type)

Declared by `dist/components/Action.d.ts` as `ActionRefreshProps`.

```ts
type ActionRefreshProps = ActionChromeProps & Readonly<{
    onRefresh: () => unknown;
}>;
```


### `.` — `Badge` (value)

Declared by `dist/components/Foundation.d.ts` as `Badge`.

```ts
function Badge({ tone, testID, children, ...text }: BadgeProps): ReactElement;
```


### `.` — `BadgeProps` (type)

Declared by `dist/components/Foundation.d.ts` as `BadgeProps`.

```ts
type BadgeProps = AuthorText & Readonly<{
    tone?: HappierTone;
    testID?: string;
    children?: ReactNode;
}>;
```


### `.` — `Banner` (value)

Declared by `dist/components/Foundation.d.ts` as `Banner`.

```ts
function Banner({ tone, title, titleKey, description, descriptionKey, ...props }: BannerProps): ReactElement;
```


### `.` — `BannerProps` (type)

Declared by `dist/components/Foundation.d.ts` as `BannerProps`.

```ts
type BannerProps = Readonly<{
    tone?: HappierTone;
    title: string;
    titleKey?: string;
    description?: string;
    descriptionKey?: string;
    action?: ReactNode;
    testID?: string;
}>;
```


### `.` — `BrandMark` (value)

Declared by `dist/components/Image.d.ts` as `BrandMark`.

```ts
function BrandMark({ pluginId, size, showName, externallyLabelled, testID }: BrandMarkProps): ReactElement;
```


### `.` — `BrandMarkProps` (type)

Declared by `dist/components/Image.d.ts` as `BrandMarkProps`.

```ts
type BrandMarkProps = Readonly<{
    pluginId?: string;
    size?: ImageProps['size'];
    showName?: boolean;
    externallyLabelled?: boolean;
    testID?: string;
}>;
```


### `.` — `Button` (value)

Declared by `dist/components/Button.d.ts` as `Button`.

```ts
function Button({ title, titleKey, accessibilityLabelKey, variant, disabled, busy, icon, accessibilityLabel, focusTarget, testID, onPress, children, }: ButtonProps): ReactElement;
```


### `.` — `ButtonProps` (type)

Declared by `dist/components/Button.d.ts` as `ButtonProps`.

```ts
type ButtonProps = ButtonWithVisibleTitleProps | ButtonWithExplicitAccessibleNameProps;
```


### `.` — `ButtonVariant` (type)

Declared by `dist/components/Button.d.ts` as `ButtonVariant`.

```ts
type ButtonVariant = 'primary' | 'secondary' | 'plain';
```


### `.` — `Card` (value)

Declared by `dist/components/Surface.d.ts` as `Card`.

```ts
function Card({ padding, ...props }: CardProps): ReactElement;
```


### `.` — `CardProps` (type)

Declared by `dist/components/Surface.d.ts` as `CardProps`.

```ts
type CardProps = SurfaceProps;
```


### `.` — `CodeBlock` (value)

Declared by `dist/components/Content.d.ts` as `CodeBlock`.

```ts
function CodeBlock({ code, language, selectable, copyLabel, copiedLabel, testID, }: CodeBlockProps): ReactElement;
```


### `.` — `CodeBlockProps` (type)

Declared by `dist/components/Content.d.ts` as `CodeBlockProps`.

```ts
type CodeBlockProps = Readonly<{
    code: string;
    language?: string;
    selectable?: boolean;
    copyLabel?: string;
    copiedLabel?: string;
    testID?: string;
}>;
```


### `.` — `ComposerContentHandleV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerContentHandleV1`.

```ts
type ComposerContentHandleV1 = Awaited<ReturnType<PluginUiHostApi['pickComposerMedia']>>;
```


### `.` — `ComposerContentInspectRequestV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerContentInspectRequestV1`.

```ts
type ComposerContentInspectRequestV1 = Parameters<PluginUiHostApi['inspectComposerContent']>[1];
```


### `.` — `ComposerContentInspectResultV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerContentInspectResultV1`.

```ts
type ComposerContentInspectResultV1 = Awaited<ReturnType<PluginUiHostApi['inspectComposerContent']>>;
```


### `.` — `ComposerContentPickMediaRequestV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerContentPickMediaRequestV1`.

```ts
type ComposerContentPickMediaRequestV1 = Parameters<PluginUiHostApi['pickComposerMedia']>[1];
```


### `.` — `ComposerContentService` (type)

Declared by `dist/composer/service.d.ts` as `ComposerContentService`.

```ts
interface ComposerContentService {
    pickMedia(request: ComposerContentPickMediaRequestV1, options?: ComposerRequestOptions): Promise<ComposerContentHandleV1>;
    inspect(handle: ComposerContentHandleV1, request: ComposerContentInspectRequestV1, options?: ComposerRequestOptions): Promise<ComposerContentInspectResultV1>;
    release(handle: ComposerContentHandleV1, options?: ComposerRequestOptions): Promise<void>;
}
```


### `.` — `ComposerDecorationResultV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerDecorationResultV1`.

```ts
type ComposerDecorationResultV1 = Awaited<ReturnType<PluginUiHostApi['setComposerDecorations']>>;
```


### `.` — `ComposerDecorationSetV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerDecorationSetV1`.

```ts
type ComposerDecorationSetV1 = SdkComposerDecorationSetV1;
```


### `.` — `ComposerFocusResultV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerFocusResultV1`.

```ts
type ComposerFocusResultV1 = Awaited<ReturnType<PluginUiHostApi['focusComposer']>>;
```


### `.` — `ComposerHandle` (type)

Declared by `dist/composer/service.d.ts` as `ComposerHandle`.

```ts
interface ComposerHandle {
    readonly ref: ComposerRefV1;
    readonly content: ComposerContentService;
    read(options?: ComposerRequestOptions): Promise<ComposerReadResultV1>;
    observe(listener: ComposerObserverV1, options?: ComposerRequestOptions): Promise<Disposable>;
    apply(transaction: ComposerTransactionV1, options?: ComposerRequestOptions): Promise<ComposerTransactionResultV1>;
    focus(options?: ComposerRequestOptions): Promise<ComposerFocusResultV1>;
    setDecorations(key: string, decorations: ComposerDecorationSetV1 | null, options?: ComposerRequestOptions): Promise<ComposerDecorationResultV1>;
    acquireInputLock(request: ComposerInputLockRequestV1, options?: ComposerRequestOptions): Promise<Disposable>;
}
```


### `.` — `ComposerInputLockRequestV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerInputLockRequestV1`.

```ts
type ComposerInputLockRequestV1 = Parameters<PluginUiHostApi['acquireComposerInputLock']>[1];
```


### `.` — `ComposerObserverV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerObserverV1`.

```ts
type ComposerObserverV1 = Parameters<PluginUiHostApi['watchComposer']>[1];
```


### `.` — `ComposerReadResultV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerReadResultV1`.

```ts
type ComposerReadResultV1 = Awaited<ReturnType<PluginUiHostApi['readComposer']>>;
```


### `.` — `ComposerRefV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerRefV1`.

```ts
type ComposerRefV1 = Parameters<PluginUiHostApi['readComposer']>[0];
```


### `.` — `ComposerRequestOptions` (type)

Declared by `dist/composer/types.d.ts` as `ComposerRequestOptions`.

```ts
type ComposerRequestOptions = Parameters<PluginUiHostApi['readComposer']>[1];
```


### `.` — `ComposerSnapshotV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerSnapshotV1`.

```ts
type ComposerSnapshotV1 = Extract<ComposerReadResultV1, Readonly<{
    status: 'ready';
}>>['snapshot'];
```


### `.` — `ComposerTransactionResultV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerTransactionResultV1`.

```ts
type ComposerTransactionResultV1 = Awaited<ReturnType<PluginUiHostApi['applyComposer']>>;
```


### `.` — `ComposerTransactionV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerTransactionV1`.

```ts
type ComposerTransactionV1 = Parameters<PluginUiHostApi['applyComposer']>[1];
```


### `.` — `ComposerViewStateV1` (type)

Declared by `dist/composer/hooks.d.ts` as `ComposerViewStateV1`.

```ts
type ComposerViewStateV1 = Readonly<{
    result: ComposerReadResultV1 | null;
    error: PluginError | null;
    pending: 'initial' | 'refresh' | null;
    refresh(): Promise<void>;
}>;
```


### `.` — `ComposersService` (type)

Declared by `dist/composer/service.d.ts` as `ComposersService`.

```ts
interface ComposersService {
    current(): ComposerHandle | null;
    active(options?: ComposerRequestOptions): Promise<ComposerHandle | null>;
    get(ref: ComposerRefV1, options?: ComposerRequestOptions): Promise<ComposerHandle | null>;
}
```


### `.` — `ContextMenu` (value)

Declared by `dist/components/Overlay.d.ts` as `ContextMenu`.

```ts
function ContextMenu(props: MenuProps): ReactElement;
```


### `.` — `DiffViewer` (value)

Declared by `dist/components/Content.d.ts` as `DiffViewer`.

```ts
function DiffViewer({ unifiedDiff, filePath, label, testID, }: DiffViewerProps): ReactElement;
```


### `.` — `DiffViewerProps` (type)

Declared by `dist/components/Content.d.ts` as `DiffViewerProps`.

```ts
type DiffViewerProps = Readonly<{
    unifiedDiff: string;
    filePath?: string;
    label: string;
    testID?: string;
}>;
```


### `.` — `Divider` (value)

Declared by `dist/components/Foundation.d.ts` as `Divider`.

```ts
function Divider(props: DividerProps): ReactElement;
```


### `.` — `DividerProps` (type)

Declared by `dist/components/Foundation.d.ts` as `DividerProps`.

```ts
type DividerProps = Readonly<{
    accessibilityLabel?: string;
    accessibilityLabelKey?: string;
    testID?: string;
}>;
```


### `.` — `Dropdown` (value)

Declared by `dist/components/Overlay.d.ts` as `Dropdown`.

```ts
function Dropdown(props: MenuProps): ReactElement;
```


### `.` — `EmptyState` (value)

Declared by `dist/components/State.d.ts` as `EmptyState`.

```ts
function EmptyState(props: EmptyStateProps): ReactElement;
```


### `.` — `EmptyStateProps` (type)

Declared by `dist/components/State.d.ts` as `EmptyStateProps`.

```ts
type EmptyStateProps = StateCopyProps;
```


### `.` — `ErrorState` (value)

Declared by `dist/components/State.d.ts` as `ErrorState`.

```ts
function ErrorState(props: ErrorStateProps): ReactElement;
```


### `.` — `ErrorStateProps` (type)

Declared by `dist/components/State.d.ts` as `ErrorStateProps`.

```ts
type ErrorStateProps = StateCopyProps;
```


### `.` — `Field` (value)

Declared by `dist/components/Form.d.ts` as `Field`.

```ts
function Field(props: FieldProps): ReactElement;
```


### `.` — `FieldProps` (type)

Declared by `dist/components/Form.d.ts` as `FieldProps`.

```ts
type FieldProps = Readonly<{
    label: string;
    description?: string;
    required?: boolean;
    disabled?: boolean;
    issue?: string;
    testID?: string;
    children?: ReactNode;
}>;
```


### `.` — `Form` (value)

Declared by `dist/components/Form.d.ts` as `Form`.

```ts
const Form: typeof FormRoot & {
    Field: typeof Field;
    TextField: typeof TextField;
    Toggle: typeof Toggle;
    Select: typeof Select;
    ValidationMessage: typeof ValidationMessage;
    Actions: typeof FormActions;
};
```


### `.` — `FormActionsProps` (type)

Declared by `dist/components/Form.d.ts` as `FormActionsProps`.

```ts
type FormActionsProps = Readonly<{
    children?: ReactNode;
}>;
```


### `.` — `FormProps` (type)

Declared by `dist/components/Form.d.ts` as `FormProps`.

```ts
type FormProps = Readonly<{
    hints: ActionFormHints;
    value: Readonly<Record<string, unknown>>;
    onChange: (value: Record<string, unknown>) => void;
    onSubmit: (value: Record<string, unknown>) => unknown;
    onCancel?: () => unknown;
    cancelLabel?: string;
    issues?: Readonly<Record<string, string | undefined>>;
    disabled?: boolean;
    busy?: boolean;
    testID?: string;
}>;
```


### `.` — `Heading` (value)

Declared by `dist/components/Foundation.d.ts` as `Heading`.

```ts
function Heading({ level, focusTarget, testID, children, ...text }: HeadingProps): ReactElement;
```


### `.` — `HeadingProps` (type)

Declared by `dist/components/Foundation.d.ts` as `HeadingProps`.

```ts
type HeadingProps = AuthorText & Readonly<{
    level?: 1 | 2 | 3 | 4 | 5 | 6;
    focusTarget?: PluginUiFocusTarget;
    testID?: string;
    children?: ReactNode;
}>;
```


### `.` — `Icon` (value)

Declared by `dist/components/Icon.d.ts` as `Icon`.

```ts
function Icon({ name, size, tone, accessibilityLabel, testID }: IconProps): ReactElement;
```


### `.` — `IconButton` (value)

Declared by `dist/components/Button.d.ts` as `IconButton`.

```ts
function IconButton({ accessibilityLabel, accessibilityLabelKey, icon, disabled, busy, selected, focusTarget, testID, onPress, }: IconButtonProps): ReactElement;
```


### `.` — `IconButtonProps` (type)

Declared by `dist/components/Button.d.ts` as `IconButtonProps`.

```ts
type IconButtonProps = Readonly<{
    accessibilityLabel: string;
    accessibilityLabelKey?: string;
    icon: ReactNode;
    disabled?: boolean;
    busy?: boolean;
    selected?: boolean;
    focusTarget?: PluginUiFocusTarget;
    testID?: string;
    onPress: () => unknown;
}>;
```


### `.` — `IconName` (type)

Declared by `dist/components/Icon.d.ts` as `IconName`.

```ts
type IconName = HappierIconName;
```


### `.` — `IconProps` (type)

Declared by `dist/components/Icon.d.ts` as `IconProps`.

```ts
type IconProps = Readonly<{
    name: IconName;
    size?: HappierIconSize;
    tone?: HappierTone;
    accessibilityLabel?: string;
    testID?: string;
}>;
```


### `.` — `Image` (value)

Declared by `dist/components/Image.d.ts` as `Image`.

```ts
function Image({ resource, size, accessibilityLabel, fallback, testID }: ImageProps): ReactElement;
```


### `.` — `ImageProps` (type)

Declared by `dist/components/Image.d.ts` as `ImageProps`.

```ts
type ImageProps = Readonly<{
    resource: PluginUiResourceReference;
    size?: HappierImageSize;
    accessibilityLabel?: string;
    fallback?: string;
    testID?: string;
}>;
```


### `.` — `Item` (value)

Declared by `dist/components/List.d.ts` as `Item`.

```ts
function Item(props: ListItemProps): ReactElement;
```


### `.` — `ItemGroup` (value)

Declared by `dist/components/List.d.ts` as `ItemGroup`.

```ts
function ItemGroup(props: ItemGroupProps): ReactElement;
```


### `.` — `ItemGroupProps` (type)

Declared by `dist/components/List.d.ts` as `ItemGroupProps`.

```ts
type ItemGroupProps = Readonly<{
    children?: ReactNode;
    accessibilityRole?: 'radiogroup';
    accessibilityLabel?: string;
    accessibilityLabelKey?: string;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `.` — `ItemProps` (type)

Declared by `dist/components/List.d.ts` as `ItemProps`.

```ts
type ItemProps = Readonly<{
    children?: ReactNode;
    title?: string;
    subtitle?: string;
    detail?: string;
    titleNumberOfLines?: number;
    subtitleNumberOfLines?: number;
    detailNumberOfLines?: number;
    icon?: ReactNode;
    accessory?: ReactNode;
    accessoryOutsidePressable?: boolean;
    accessoryWraps?: boolean;
    tone?: HappierTone;
    onPress?: (event?: HappierGestureResponderEvent) => unknown;
    disabled?: boolean;
    busy?: boolean;
    selected?: boolean;
    accessibilityRole?: 'radio' | 'option' | 'button';
    accessibilityExpanded?: boolean;
    accessibilityPositionInSet?: number;
    accessibilitySetSize?: number;
    density?: 'comfortable' | 'cozy' | 'compact' | 'tight';
    showDivider?: boolean;
    accessibilityLabel?: string;
    accessibilityLabelKey?: string;
    accessibilityHint?: string;
    accessibilityHintKey?: string;
    testID?: string;
    style?: HappierStyleProp;
}> & ItemSecondaryActionsProps;
```


### `.` — `Label` (value)

Declared by `dist/components/Foundation.d.ts` as `Label`.

```ts
function Label({ testID, children, ...text }: LabelProps): ReactElement;
```


### `.` — `LabelProps` (type)

Declared by `dist/components/Foundation.d.ts` as `LabelProps`.

```ts
type LabelProps = AuthorText & Readonly<{
    testID?: string;
    children?: ReactNode;
}>;
```


### `.` — `LayoutChangeEvent` (type)

Declared by `dist/components/Layout.d.ts` as `LayoutChangeEvent`.

```ts
type LayoutChangeEvent = HappierLayoutChangeEvent;
```


### `.` — `LayoutGap` (type)

Declared by `dist/components/Layout.d.ts` as `LayoutGap`.

```ts
type LayoutGap = HappierLayoutGap;
```


### `.` — `Link` (value)

Declared by `dist/components/Foundation.d.ts` as `Link`.

```ts
function Link({ title, titleKey, url, disabled, testID }: LinkProps): ReactElement;
```


### `.` — `LinkProps` (type)

Declared by `dist/components/Foundation.d.ts` as `LinkProps`.

```ts
type LinkProps = Readonly<{
    title: string;
    titleKey?: string;
    url: string;
    disabled?: boolean;
    testID?: string;
}>;
```


### `.` — `List` (value)

Declared by `dist/components/List.d.ts` as `List`.

```ts
const List: typeof ListRoot & {
    Section: typeof ListSection;
    Item: typeof ListItem;
    SelectionActionBar: typeof ListSelectionActionBar;
};
```


### `.` — `ListAccessibilityPattern` (type)

Declared by `dist/components/List.d.ts` as `ListAccessibilityPattern`.

```ts
type ListAccessibilityPattern = 'listbox' | 'grid';
```


### `.` — `ListBulkAction` (type)

Declared by `dist/components/ListMultiSelection.d.ts` as `ListBulkAction`.

```ts
type ListBulkAction = Readonly<{
    id: string;
    label?: string;
    labelKey?: string;
    labelFallback?: string;
    icon?: ReactNode;
    tone?: HappierTone;
    disabled?: boolean;
    testID?: string;
}>;
```


### `.` — `ListHeaderContext` (type)

Declared by `dist/components/List.d.ts` as `ListHeaderContext`.

```ts
type ListHeaderContext<Item> = Readonly<{
    selectedItem: Item | null;
}>;
```


### `.` — `ListItemProps` (type)

Declared by `dist/components/List.d.ts` as `ListItemProps`.

```ts
type ListItemProps = ItemProps;
```


### `.` — `ListMultiSelectionActions` (type)

Declared by `dist/components/ListMultiSelection.d.ts` as `ListMultiSelectionActions`.

```ts
type ListMultiSelectionActions = HappierListMultiSelectionActions;
```


### `.` — `ListMultiSelectionCapabilityProps` (type)

Declared by `dist/components/List.d.ts` as `ListMultiSelectionCapabilityProps`.

```ts
type ListMultiSelectionCapabilityProps<Item = unknown> = Readonly<{
    store: ListMultiSelectionStore;
    isItemSelectable?: (item: Item, index: number) => boolean;
    retainedSelectionKeys?: readonly ListMultiSelectionKey[];
}>;
```


### `.` — `ListMultiSelectionKey` (type)

Declared by `dist/components/ListMultiSelection.d.ts` as `ListMultiSelectionKey`.

```ts
type ListMultiSelectionKey = HappierListMultiSelectionKey;
```


### `.` — `ListMultiSelectionProvider` (value)

Declared by `dist/components/ListMultiSelection.d.ts` as `ListMultiSelectionProvider`.

```ts
function ListMultiSelectionProvider(props: ListMultiSelectionProviderProps): ReactElement;
```


### `.` — `ListMultiSelectionProviderProps` (type)

Declared by `dist/components/ListMultiSelection.d.ts` as `ListMultiSelectionProviderProps`.

```ts
type ListMultiSelectionProviderProps = Readonly<{
    store: ListMultiSelectionStore | null;
    children?: ReactNode;
}>;
```


### `.` — `ListMultiSelectionRow` (type)

Declared by `dist/components/ListMultiSelection.d.ts` as `ListMultiSelectionRow`.

```ts
type ListMultiSelectionRow = Readonly<{
    isSelectionMode: boolean;
    isSelected: boolean;
    isFocused: boolean;
    replace: () => void;
    toggle: () => void;
    selectRange: () => void;
    addRange: () => void;
    setFocused: () => void;
}>;
```


### `.` — `ListMultiSelectionSnapshot` (type)

Declared by `dist/components/ListMultiSelection.d.ts` as `ListMultiSelectionSnapshot`.

```ts
type ListMultiSelectionSnapshot = HappierListMultiSelectionSnapshot;
```


### `.` — `ListMultiSelectionStore` (type)

Declared by `dist/components/ListMultiSelection.d.ts` as `ListMultiSelectionStore`.

```ts
type ListMultiSelectionStore = HappierListMultiSelectionStore;
```


### `.` — `ListProps` (type)

Declared by `dist/components/List.d.ts` as `ListProps`.

```ts
type ListProps<Item> = ListBaseProps & (VirtualizedListProps<Item> | StaticListProps);
```


### `.` — `ListSearchProps` (type)

Declared by `dist/components/List.d.ts` as `ListSearchProps`.

```ts
type ListSearchProps<Item> = ListSearchBaseProps<Item> & (Readonly<{
    value: string;
    defaultValue?: never;
    onValueChange: (value: string) => void;
}> | Readonly<{
    value?: never;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
}>);
```


### `.` — `ListSectionData` (type)

Declared by `dist/components/List.d.ts` as `ListSectionData`.

```ts
type ListSectionData<Item> = Readonly<{
    key: string;
    title: string;
    data: readonly Item[];
}>;
```


### `.` — `ListSectionProps` (type)

Declared by `dist/components/List.d.ts` as `ListSectionProps`.

```ts
type ListSectionProps = Readonly<{
    children?: ReactNode;
    title: string;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `.` — `ListSelectionActionBar` (value)

Declared by `dist/components/ListMultiSelection.d.ts` as `ListSelectionActionBar`.

```ts
function ListSelectionActionBar(props: ListSelectionActionBarProps): ReactElement | null;
```


### `.` — `ListSelectionActionBarProps` (type)

Declared by `dist/components/ListMultiSelection.d.ts` as `ListSelectionActionBarProps`.

```ts
type ListSelectionActionBarProps = Readonly<{
    actions: readonly ListBulkAction[];
    onAction: (actionId: string, keys: readonly ListMultiSelectionKey[]) => void;
    onDismiss?: () => void;
    accessibilityLabel?: string;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `.` — `ListSelectionProps` (type)

Declared by `dist/components/List.d.ts` as `ListSelectionProps`.

```ts
type ListSelectionProps<Item = unknown> = ListSelectionBaseProps<Item> & (Readonly<{
    selectedKey: string | null;
    defaultSelectedKey?: never;
    onSelectedKeyChange: (key: string) => void;
}> | Readonly<{
    selectedKey?: never;
    defaultSelectedKey?: string | null;
    onSelectedKeyChange?: (key: string) => void;
}>);
```


### `.` — `LoadingState` (value)

Declared by `dist/components/State.d.ts` as `LoadingState`.

```ts
function LoadingState(props: LoadingStateProps): ReactElement;
```


### `.` — `LoadingStateProps` (type)

Declared by `dist/components/State.d.ts` as `LoadingStateProps`.

```ts
type LoadingStateProps = StateCopyProps;
```


### `.` — `Markdown` (value)

Declared by `dist/components/Content.d.ts` as `Markdown`.

```ts
function Markdown({ value, selectable, testID }: MarkdownProps): ReactElement;
```


### `.` — `MarkdownProps` (type)

Declared by `dist/components/Content.d.ts` as `MarkdownProps`.

```ts
type MarkdownProps = Readonly<{
    value: string;
    selectable?: boolean;
    testID?: string;
}>;
```


### `.` — `Menu` (value)

Declared by `dist/components/Overlay.d.ts` as `Menu`.

```ts
function Menu(props: MenuProps): ReactElement;
```


### `.` — `MenuGroup` (type)

Declared by `dist/components/Overlay.d.ts` as `MenuGroup`.

```ts
type MenuGroup = Readonly<{
    id: string;
    accessibilityLabel: string;
    items: readonly MenuItem[];
}>;
```


### `.` — `MenuItem` (type)

Declared by `dist/components/Overlay.d.ts` as `MenuItem`.

```ts
type MenuItem = MenuItemBase & (Readonly<{
    kind?: 'action';
    checked?: never;
    radioGroupId?: never;
}> | Readonly<{
    kind: 'checkbox';
    checked: boolean;
    radioGroupId?: never;
}> | Readonly<{
    kind: 'radio';
    radioGroupId: string;
    checked?: never;
}>);
```


### `.` — `MenuProps` (type)

Declared by `dist/components/Overlay.d.ts` as `MenuProps`.

```ts
type MenuProps = Omit<PopoverProps, 'children'> & MenuContentProps & Readonly<{
    radioGroups?: readonly MenuRadioGroup[];
    onSelect(id: string): void;
}>;
```


### `.` — `MenuRadioGroup` (type)

Declared by `dist/components/Overlay.d.ts` as `MenuRadioGroup`.

```ts
type MenuRadioGroup = Readonly<{
    id: string;
    accessibilityLabel: string;
    selectedId: string | null;
}>;
```


### `.` — `Metadata` (value)

Declared by `dist/components/Foundation.d.ts` as `Metadata`.

```ts
function Metadata(props: MetadataProps): ReactElement;
```


### `.` — `MetadataEntry` (type)

Declared by `dist/components/Foundation.d.ts` as `MetadataEntry`.

```ts
type MetadataEntry = Readonly<{
    label: string;
    labelKey?: string;
    value: string;
    tone?: HappierTone;
    accessibilityLabel?: string;
    accessibilityLabelKey?: string;
    testID?: string;
}>;
```


### `.` — `MetadataProps` (type)

Declared by `dist/components/Foundation.d.ts` as `MetadataProps`.

```ts
type MetadataProps = Readonly<{
    title?: string;
    titleKey?: string;
    entries: readonly MetadataEntry[];
    testID?: string;
}>;
```


### `.` — `PluginAccessibilityFacts` (type)

Declared by `dist/components/PluginUiProvider.d.ts` as `PluginAccessibilityFacts`.

```ts
type PluginAccessibilityFacts = HappierUiAccessibility;
```


### `.` — `PluginActionExecution` (type)

Declared by `dist/hostApi/executeAction.d.ts` as `PluginActionExecution`.

```ts
type PluginActionExecution<Result = unknown> = Readonly<{
    status: 'idle';
}> | Readonly<{
    status: 'pending';
}> | Readonly<{
    status: 'success';
    result: Result;
}> | Readonly<{
    status: 'error';
    code: string;
    message: string;
    retryable: boolean;
}> | Readonly<{
    status: 'outcomeUnknown';
    code: string;
    message: string;
}>;
```


### `.` — `PluginActionExecutionController` (type)

Declared by `dist/hostApi/executeAction.d.ts` as `PluginActionExecutionController`.

```ts
type PluginActionExecutionController<Result, Input = JsonValue> = Readonly<{
    execution: PluginActionExecution<Result>;
    execute: (input?: Input, options?: PluginUiActionExecutionOptions) => Promise<PluginActionExecution<Result>>;
    reset: () => void;
}>;
```


### `.` — `PluginActionInput` (type)

Re-exported from another package as `ProtocolJsonValue`; that package owns the declaration.

```ts
// declared by another package — see its own declaration report
```


### `.` — `PluginActionInputFor` (type)

Re-exported from another package as `PluginUiActionInputFor`; that package owns the declaration.

```ts
// declared by another package — see its own declaration report
```


### `.` — `PluginActionReference` (type)

Re-exported from another package as `PluginUiActionReference`; that package owns the declaration.

```ts
// declared by another package — see its own declaration report
```


### `.` — `PluginActionResultFor` (type)

Re-exported from another package as `PluginUiActionResultFor`; that package owns the declaration.

```ts
// declared by another package — see its own declaration report
```


### `.` — `PluginTranslate` (type)

Declared by `dist/components/PluginUiProvider.d.ts` as `PluginTranslate`.

```ts
type PluginTranslate = (key: string, fallback?: string, values?: PluginTranslationValues) => string;
```


### `.` — `PluginTranslationValues` (type)

Declared by `dist/components/PluginUiProvider.d.ts` as `PluginTranslationValues`.

```ts
type PluginTranslationValues = Readonly<Record<string, string | number>>;
```


### `.` — `PluginUiEphemeralSharedScope` (type)

Declared by `dist/hostApi/ephemeralSharedScope.public.d.ts` as `PluginUiEphemeralSharedScope`.

```ts
type PluginUiEphemeralSharedScope = Readonly<{
    acquire<T>(localKey: string, create: () => Readonly<{
        value: T;
        dispose(): void;
    }>): PluginUiEphemeralSharedValueLease<T> | null;
}>;
```


### `.` — `PluginUiEphemeralSharedValueLease` (type)

Declared by `dist/hostApi/ephemeralSharedScope.public.d.ts` as `PluginUiEphemeralSharedValueLease`.

```ts
type PluginUiEphemeralSharedValueLease<T> = Readonly<{
    value: T;
    release(): void;
}>;
```


### `.` — `PluginUiFocusTarget` (type)

Declared by `dist/components/Focus.d.ts` as `PluginUiFocusTarget`.

```ts
type PluginUiFocusTarget = Readonly<{
    focus(): boolean;
}>;
```


### `.` — `PluginUiHostApi` (type)

Re-exported from another package as `PluginUiHostApi`; that package owns the declaration.

```ts
// declared by another package — see its own declaration report
```


### `.` — `PluginUiResourceError` (type)

Declared by `dist/hostApi/resourceStore.d.ts` as `PluginUiResourceError`.

```ts
type PluginUiResourceError = Readonly<{
    code?: string;
    diagnostics?: readonly string[];
    message: string;
}>;
```


### `.` — `PluginUiResourceReference` (type)

Declared by `dist/hostApi/resourceStore.d.ts` as `PluginUiResourceReference`.

```ts
type PluginUiResourceReference = Parameters<PluginUiHostApi['readResource']>[0];
```


### `.` — `PluginUiResourceResult` (type)

Declared by `dist/hostApi/index.d.ts` as `PluginUiResourceResult`.

```ts
type PluginUiResourceResult = Readonly<{
    resource: PluginUiResourceSnapshot;
    refresh: () => void;
}>;
```


### `.` — `PluginUiResourceSnapshot` (type)

Declared by `dist/hostApi/resourceStore.d.ts` as `PluginUiResourceSnapshot`.

```ts
type PluginUiResourceSnapshot = Readonly<{
    value?: ResourceContent;
    digest?: string;
    freshness: 'unknown' | 'fresh' | 'stale';
    pending: 'idle' | 'initial' | 'refresh';
    error?: PluginUiResourceError;
    subscription: 'unsupported' | 'establishing' | 'live' | 'reconnecting' | 'ended';
}>;
```


### `.` — `PluginUiResourceState` (type)

Declared by `dist/components/State.d.ts` as `PluginUiResourceState`.

```ts
type PluginUiResourceState<Value = unknown> = Readonly<{
    status: 'idle' | 'loading';
}> | Readonly<{
    status: 'ready';
    value: Value;
}> | Readonly<{
    status: 'empty';
}> | Readonly<{
    status: 'unavailable' | 'stale' | 'complete';
    diagnostics?: readonly string[];
}> | Readonly<{
    status: 'error';
    code?: string;
    message?: string;
    diagnostics?: readonly string[];
}>;
```


### `.` — `Popover` (value)

Declared by `dist/components/Overlay.d.ts` as `Popover`.

```ts
function Popover(props: PopoverProps): ReactElement;
```


### `.` — `PopoverProps` (type)

Declared by `dist/components/Overlay.d.ts` as `PopoverProps`.

```ts
type PopoverProps = Readonly<{
    open: boolean;
    onOpenChange(open: boolean): void;
    trigger: string;
    triggerTextVariant?: HappierTextVariant;
    triggerTextTone?: HappierTone;
    triggerAccessibilityLabel: string;
    contentAccessibilityLabel?: string;
    children?: ReactNode;
    placement?: 'auto' | 'top' | 'bottom' | 'left' | 'right';
    disabled?: boolean;
    testID?: string;
    triggerTabIndex?: -1 | 0;
    focusReturnRef?: RefObject<unknown>;
}>;
```


### `.` — `Progress` (value)

Declared by `dist/components/Foundation.d.ts` as `Progress`.

```ts
function Progress({ label, labelKey, ...props }: ProgressProps): ReactElement;
```


### `.` — `ProgressProps` (type)

Declared by `dist/components/Foundation.d.ts` as `ProgressProps`.

```ts
type ProgressProps = Readonly<{
    value?: number;
    label: string;
    labelKey?: string;
    testID?: string;
}>;
```


### `.` — `ReviewCommentProposalQueryV1` (type)

Declared by `dist/hostApi/reviewCommentProposals.public.d.ts` as `ReviewCommentProposalQueryV1`.

```ts
type ReviewCommentProposalQueryV1 = Readonly<{
    linkedSessionIds: readonly string[];
    entry: Readonly<{
        kind: 'pullRequest';
        url?: string;
    }> | Readonly<{
        kind: 'issue';
        id: string;
    }>;
}>;
```


### `.` — `ReviewCommentProposalReadV1` (type)

Declared by `dist/hostApi/reviewCommentProposals.public.d.ts` as `ReviewCommentProposalReadV1`.

```ts
type ReviewCommentProposalReadV1 = Readonly<{
    status: 'loading' | 'ready' | 'failed';
    proposals: readonly ReviewCommentProposalWithBodyV1[];
}>;
```


### `.` — `ReviewCommentProposalWithBodyV1` (type)

Declared by `dist/hostApi/reviewCommentProposals.public.d.ts` as `ReviewCommentProposalWithBodyV1`.

```ts
type ReviewCommentProposalWithBodyV1 = Omit<ReviewCommentV1, 'body' | 'snapshot'> & Readonly<{
    body: string;
    snapshot: ReviewCommentSnapshotV1;
}>;
```


### `.` — `Row` (value)

Declared by `dist/components/Layout.d.ts` as `Row`.

```ts
function Row({ gap, focusTarget, ...props }: RowProps): ReactElement;
```


### `.` — `RowProps` (type)

Declared by `dist/components/Layout.d.ts` as `RowProps`.

```ts
type RowProps = StackProps;
```


### `.` — `Screen` (value)

Declared by `dist/components/Layout.d.ts` as `Screen`.

```ts
function Screen({ children, safeArea, focusTarget, ...props }: ScreenProps): ReactElement;
```


### `.` — `ScreenProps` (type)

Declared by `dist/components/Layout.d.ts` as `ScreenProps`.

```ts
type ScreenProps = Readonly<{
    children?: ReactNode;
    safeArea?: boolean;
    focusTarget?: PluginUiFocusTarget;
    onLayout?: (event: LayoutChangeEvent) => void;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `.` — `ScrollArea` (value)

Declared by `dist/components/Layout.d.ts` as `ScrollArea`.

```ts
function ScrollArea({ children, safeArea, ...props }: ScrollAreaProps): ReactElement;
```


### `.` — `ScrollAreaProps` (type)

Declared by `dist/components/Layout.d.ts` as `ScrollAreaProps`.

```ts
type ScrollAreaProps = Readonly<{
    children?: ReactNode;
    horizontal?: boolean;
    keyboardShouldPersistTaps?: HappierKeyboardShouldPersistTaps;
    onScroll?: (event: HappierScrollEvent) => void;
    scrollEventThrottle?: number;
    onLayout?: (event: LayoutChangeEvent) => void;
    accessibilityLabel?: string;
    safeArea?: boolean;
    testID?: string;
    style?: HappierStyleProp;
    contentContainerStyle?: HappierStyleProp;
}>;
```


### `.` — `Select` (value)

Declared by `dist/components/Form.d.ts` as `Select`.

```ts
function Select(props: SelectProps): ReactElement;
```


### `.` — `SelectOption` (type)

Declared by `dist/components/Form.d.ts` as `SelectOption`.

```ts
type SelectOption = FormOption;
```


### `.` — `SelectProps` (type)

Declared by `dist/components/Form.d.ts` as `SelectProps`.

```ts
type SelectProps = Readonly<{
    label: string;
    options: readonly SelectOption[];
    value?: FormOptionValue | readonly FormOptionValue[];
    multiple?: boolean;
    maxSelections?: number;
    minimumSelections?: number;
    required?: boolean;
    onChange: (value: FormOptionValue | readonly FormOptionValue[]) => void;
    disabled?: boolean;
    focusTarget?: PluginUiFocusTarget;
    testID?: string;
}>;
```


### `.` — `Spinner` (value)

Declared by `dist/components/Spinner.d.ts` as `Spinner`.

```ts
function Spinner({ size, tone, accessibilityLabel, testID }: SpinnerProps): ReactElement;
```


### `.` — `SpinnerProps` (type)

Declared by `dist/components/Spinner.d.ts` as `SpinnerProps`.

```ts
type SpinnerProps = Readonly<{
    size?: SpinnerSize;
    tone?: TextTone;
    accessibilityLabel?: string;
    testID?: string;
}>;
```


### `.` — `SpinnerSize` (type)

Declared by `dist/components/Spinner.d.ts` as `SpinnerSize`.

```ts
type SpinnerSize = 'small' | 'large' | number;
```


### `.` — `Stack` (value)

Declared by `dist/components/Layout.d.ts` as `Stack`.

```ts
function Stack({ gap, focusTarget, ...props }: StackProps): ReactElement;
```


### `.` — `StackProps` (type)

Declared by `dist/components/Layout.d.ts` as `StackProps`.

```ts
type StackProps = Readonly<{
    children?: ReactNode;
    gap?: LayoutGap;
    wrap?: boolean;
    align?: HappierAlignment;
    justify?: HappierJustification;
    focusTarget?: PluginUiFocusTarget;
    onLayout?: (event: LayoutChangeEvent) => void;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `.` — `State` (value)

Declared by `dist/components/State.d.ts` as `State`.

```ts
function State<Value>({ resource, loading, empty, error, children, }: StateProps<Value>): ReactElement | null;
```


### `.` — `StateProps` (type)

Declared by `dist/components/State.d.ts` as `StateProps`.

```ts
type StateProps<Value> = Readonly<{
    resource?: PluginUiResourceState<Value>;
    loading?: ReactNode;
    empty?: ReactNode;
    error?: ReactNode | ((state: Extract<PluginUiResourceState<Value>, {
        status: 'error';
    }>) => ReactNode);
    children?: ReactNode | ((value: Value) => ReactNode);
}>;
```


### `.` — `Status` (value)

Declared by `dist/components/Status.d.ts` as `Status`.

```ts
function Status({ tone, label, labelKey, pulsing, focusTarget, testID }: StatusProps): ReactElement;
```


### `.` — `StatusProps` (type)

Declared by `dist/components/Status.d.ts` as `StatusProps`.

```ts
type StatusProps = Readonly<{
    tone: TextTone;
    label: string;
    labelKey?: string;
    pulsing?: boolean;
    focusTarget?: PluginUiFocusTarget;
    testID?: string;
}>;
```


### `.` — `Surface` (value)

Declared by `dist/components/Surface.d.ts` as `Surface`.

```ts
function Surface(props: SurfaceProps): ReactElement;
```


### `.` — `SurfacePadding` (type)

Declared by `dist/components/Surface.d.ts` as `SurfacePadding`.

```ts
type SurfacePadding = 'none' | 'small' | 'medium' | 'large';
```


### `.` — `SurfaceProps` (type)

Declared by `dist/components/Surface.d.ts` as `SurfaceProps`.

```ts
type SurfaceProps = Readonly<{
    children?: ReactNode;
    tone?: SurfaceTone;
    padding?: SurfacePadding;
    testID?: string;
    onPress?: () => unknown;
    disabled?: boolean;
    accessibilityLabel?: string;
}>;
```


### `.` — `SurfaceTone` (type)

Declared by `dist/components/Surface.d.ts` as `SurfaceTone`.

```ts
type SurfaceTone = 'surface' | 'muted';
```


### `.` — `TabPanelActivity` (type)

Declared by `dist/components/Tabs.d.ts` as `TabPanelActivity`.

```ts
type TabPanelActivity = HappierTabPanelActivity;
```


### `.` — `Tabs` (value)

Declared by `dist/components/Tabs.d.ts` as `Tabs`.

```ts
const Tabs: typeof TabsRoot & {
    Item: typeof TabsItem;
};
```


### `.` — `TabsItemProps` (type)

Declared by `dist/components/Tabs.d.ts` as `TabsItemProps`.

```ts
type TabsItemProps = Readonly<{
    value: string;
    title: string;
    icon?: ReactNode;
    badge?: string;
    disabled?: boolean;
    retention?: HappierTabRetention;
    children?: ReactNode;
}>;
```


### `.` — `TabsProps` (type)

Declared by `dist/components/Tabs.d.ts` as `TabsProps`.

```ts
type TabsProps = Readonly<{
    value: string;
    onValueChange: (value: string) => void;
    ariaLabel: string;
    testID?: string;
    children?: ReactNode;
}>;
```


### `.` — `TargetedSurface` (value)

Declared by `dist/components/TargetedSurface.d.ts` as `TargetedSurface`.

```ts
function TargetedSurface<TInput extends JsonValue = JsonValue, TPointId extends string = string, TSurface extends PluginUiTargetedContributionSurfaceV1 = ContributionSurfaceHandle<TInput, TPointId>>({ surface, input, instanceKey, fallback }: TargetedSurfaceProps<TInput, TPointId, TSurface>): ReactElement | null;
```


### `.` — `TargetedSurfaceProps` (type)

Declared by `dist/components/TargetedSurface.d.ts` as `TargetedSurfaceProps`.

```ts
type TargetedSurfaceProps<TInput extends JsonValue = JsonValue, TPointId extends string = string, TSurface extends PluginUiTargetedContributionSurfaceV1 = ContributionSurfaceHandle<TInput, TPointId>> = Readonly<{
    surface: TSurface;
    input: TargetedSurfaceInput<TSurface>;
    instanceKey?: string;
    fallback?: ReactNode;
}>;
```


### `.` — `Text` (value)

Declared by `dist/components/Text.d.ts` as `Text`.

```ts
function Text({ value, valueKey, fallback, values, tone, variant, numberOfLines, selectable, accessibilityLabel, testID, children, }: TextProps): ReactElement;
```


### `.` — `TextField` (value)

Declared by `dist/components/Form.d.ts` as `TextField`.

```ts
function TextField(props: TextFieldProps): ReactElement;
```


### `.` — `TextFieldProps` (type)

Declared by `dist/components/Form.d.ts` as `TextFieldProps`.

```ts
type TextFieldProps = Readonly<{
    label: string;
    labelKey?: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    placeholderKey?: string;
    disabled?: boolean;
    required?: boolean;
    secure?: boolean;
    multiline?: boolean;
    keyboardType?: 'default' | 'url' | 'numeric';
    autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
    autoCorrect?: boolean;
    selection?: TextSelection;
    onSelectionChange?: (selection: TextSelection) => void;
    onSubmitEditing?: () => void;
    onCompositionChange?: (isComposing: boolean) => void;
    onEscape?: () => boolean;
    focusTarget?: PluginUiFocusTarget;
    testID?: string;
}>;
```


### `.` — `TextProps` (type)

Declared by `dist/components/Text.d.ts` as `TextProps`.

```ts
type TextProps = Readonly<{
    value?: string;
    valueKey?: string;
    fallback?: string;
    values?: PluginTranslationValues;
    tone?: TextTone;
    variant?: TextVariant;
    numberOfLines?: number;
    selectable?: boolean;
    accessibilityLabel?: string;
    testID?: string;
    children?: ReactNode;
}>;
```


### `.` — `TextSelection` (type)

Declared by `dist/components/Form.d.ts` as `TextSelection`.

```ts
type TextSelection = HappierTextSelection;
```


### `.` — `TextTone` (type)

Declared by `dist/components/Text.d.ts` as `TextTone`.

```ts
type TextTone = HappierTone;
```


### `.` — `TextVariant` (type)

Declared by `dist/components/Text.d.ts` as `TextVariant`.

```ts
type TextVariant = HappierTextVariant;
```


### `.` — `Toggle` (value)

Declared by `dist/components/Form.d.ts` as `Toggle`.

```ts
function Toggle(props: ToggleProps): ReactElement;
```


### `.` — `ToggleProps` (type)

Declared by `dist/components/Form.d.ts` as `ToggleProps`.

```ts
type ToggleProps = Readonly<{
    label: string;
    value: boolean;
    onChange: (value: boolean) => void;
    disabled?: boolean;
    testID?: string;
}>;
```


### `.` — `UiSurfaceComponent` (type)

Declared by `dist/surfaceEntry.d.ts` as `UiSurfaceComponent`.

```ts
type UiSurfaceComponent = ComponentType<RenderContext>;
```


### `.` — `UseListMultiSelectionControllerInput` (type)

Declared by `dist/components/ListMultiSelection.d.ts` as `UseListMultiSelectionControllerInput`.

```ts
type UseListMultiSelectionControllerInput = Readonly<{
    scopeKey: string;
    rows: 'collection';
    visibleOrderedKeys?: never;
    eligibleKeys?: never;
    enabled?: boolean;
}> | Readonly<{
    scopeKey: string;
    rows?: never;
    visibleOrderedKeys: readonly ListMultiSelectionKey[];
    eligibleKeys?: readonly ListMultiSelectionKey[] | ReadonlySet<ListMultiSelectionKey> | null;
    enabled?: boolean;
}>;
```


### `.` — `ValidationMessage` (value)

Declared by `dist/components/Form.d.ts` as `ValidationMessage`.

```ts
function ValidationMessage({ message, testID }: ValidationMessageProps): ReactElement;
```


### `.` — `ValidationMessageProps` (type)

Declared by `dist/components/Form.d.ts` as `ValidationMessageProps`.

```ts
type ValidationMessageProps = Readonly<{
    message: string;
    testID?: string;
}>;
```


### `.` — `createListMultiSelectionStore` (value)

Declared by `dist/components/ListMultiSelection.d.ts` as `createListMultiSelectionStore`.

```ts
const createListMultiSelectionStore: (input: CreateHappierListMultiSelectionStateInput) => ListMultiSelectionStore;
```


### `.` — `defineUiSurface` (value)

Declared by `dist/surfaceEntry.d.ts` as `defineUiSurface`.

```ts
function defineUiSurface(Surface: UiSurfaceComponent): RenderSurface;
```


### `.` — `useComposer` (value)

Declared by `dist/composer/hooks.d.ts` as `useComposer`.

```ts
function useComposer(): ComposersService;
```


### `.` — `useComposerView` (value)

Declared by `dist/composer/hooks.d.ts` as `useComposerView`.

```ts
function useComposerView(handle: ComposerHandle | null): ComposerViewStateV1;
```


### `.` — `useExecutePluginAction` (value)

Declared by `dist/hostApi/executeAction.d.ts` as `useExecutePluginAction`.

```ts
function useExecutePluginAction<TAction extends PluginUiActionReference>(action: TAction, input?: NoInfer<PluginUiActionInputFor<NoInfer<TAction>>>): PluginActionExecutionController<PluginUiActionResultFor<NoInfer<TAction>>, PluginUiActionInputFor<NoInfer<TAction>>>;
```


### `.` — `useListMultiSelectionController` (value)

Declared by `dist/components/ListMultiSelection.d.ts` as `useListMultiSelectionController`.

```ts
function useListMultiSelectionController(input: UseListMultiSelectionControllerInput): ListMultiSelectionStore;
```


### `.` — `useListMultiSelectionRow` (value)

Declared by `dist/components/ListMultiSelection.d.ts` as `useListMultiSelectionRow`.

```ts
function useListMultiSelectionRow(key: ListMultiSelectionKey): ListMultiSelectionRow;
```


### `.` — `useListMultiSelectionSnapshot` (value)

Declared by `dist/components/ListMultiSelection.d.ts` as `useListMultiSelectionSnapshot`.

```ts
function useListMultiSelectionSnapshot(): ListMultiSelectionSnapshot;
```


### `.` — `useListMultiSelectionStoreSnapshot` (value)

Declared by `dist/components/ListMultiSelection.d.ts` as `useListMultiSelectionStoreSnapshot`.

```ts
function useListMultiSelectionStoreSnapshot(store: ListMultiSelectionStore | null): ListMultiSelectionSnapshot;
```


### `.` — `useLivePluginResource` (value)

Declared by `dist/hostApi/index.d.ts` as `useLivePluginResource`.

```ts
function useLivePluginResource(resource: PluginUiResourceReference): PluginUiResourceResult;
```


### `.` — `useOptionalListMultiSelectionStore` (value)

Declared by `dist/components/ListMultiSelection.d.ts` as `useOptionalListMultiSelectionStore`.

```ts
function useOptionalListMultiSelectionStore(): ListMultiSelectionStore | null;
```


### `.` — `usePluginAccessibility` (value)

Declared by `dist/components/PluginUiProvider.d.ts` as `usePluginAccessibility`.

```ts
function usePluginAccessibility(): PluginAccessibilityFacts;
```


### `.` — `usePluginBrandDisplayName` (value)

Declared by `dist/components/Image.d.ts` as `usePluginBrandDisplayName`.

```ts
function usePluginBrandDisplayName(pluginId?: string): string | undefined;
```


### `.` — `usePluginBrandDisplayNameResolver` (value)

Declared by `dist/components/Image.d.ts` as `usePluginBrandDisplayNameResolver`.

```ts
function usePluginBrandDisplayNameResolver(): (pluginId?: string) => string | undefined;
```


### `.` — `usePluginHostApi` (value)

Declared by `dist/hostApi/context.d.ts` as `usePluginHostApi`.

```ts
function usePluginHostApi(): PluginUiHostApi;
```


### `.` — `usePluginResource` (value)

Declared by `dist/hostApi/index.d.ts` as `usePluginResource`.

```ts
function usePluginResource(resource: PluginUiResourceReference): PluginUiResourceResult;
```


### `.` — `usePluginSurfaceActivity` (value)

Declared by `dist/hostApi/context.d.ts` as `usePluginSurfaceActivity`.

```ts
function usePluginSurfaceActivity(): Readonly<{
    active: boolean;
}>;
```


### `.` — `usePluginTheme` (value)

Declared by `dist/components/PluginUiProvider.d.ts` as `usePluginTheme`.

```ts
function usePluginTheme(): PluginUiThemeV1;
```


### `.` — `usePluginTranslation` (value)

Declared by `dist/components/PluginUiProvider.d.ts` as `usePluginTranslation`.

```ts
function usePluginTranslation(): PluginTranslate;
```


### `.` — `usePluginUiEphemeralSharedScope` (value)

Declared by `dist/hostApi/context.d.ts` as `usePluginUiEphemeralSharedScope`.

```ts
function usePluginUiEphemeralSharedScope(): PluginUiEphemeralSharedScope | null;
```


### `.` — `usePluginUiFocusTarget` (value)

Declared by `dist/components/Focus.d.ts` as `usePluginUiFocusTarget`.

```ts
function usePluginUiFocusTarget(): PluginUiFocusTarget;
```


### `.` — `useReviewCommentProposalsForEntry` (value)

Declared by `dist/hostApi/reviewCommentProposals.public.d.ts` as `useReviewCommentProposalsForEntry`.

```ts
function useReviewCommentProposalsForEntry(query: ReviewCommentProposalQueryV1): ReviewCommentProposalReadV1;
```


### `.` — `useSurfaceContext` (value)

Declared by `dist/components/PluginUiProvider.d.ts` as `useSurfaceContext`.

```ts
function useSurfaceContext(): SurfaceContext;
```


### `.` — `useTabPanelActivity` (value)

Declared by `dist/components/Tabs.d.ts` as `useTabPanelActivity`.

```ts
function useTabPanelActivity(): TabPanelActivity;
```


### `./advanced` — `HAPPIER_MAX_RENDERABLE_IMAGE_BYTES` (value)

Declared by `dist/presentation/content/renderableImage.d.ts` as `HAPPIER_MAX_RENDERABLE_IMAGE_BYTES`.

```ts
const HAPPIER_MAX_RENDERABLE_IMAGE_BYTES: number;
```


### `./advanced` — `HAPPIER_MAX_RENDERABLE_IMAGE_PIXELS` (value)

Declared by `dist/presentation/content/renderableImage.d.ts` as `HAPPIER_MAX_RENDERABLE_IMAGE_PIXELS`.

```ts
const HAPPIER_MAX_RENDERABLE_IMAGE_PIXELS: 4194304;
```


### `./advanced` — `HAPPIER_RENDERABLE_IMAGE_CONTENT_TYPE` (value)

Declared by `dist/presentation/content/renderableImage.d.ts` as `HAPPIER_RENDERABLE_IMAGE_CONTENT_TYPE`.

```ts
const HAPPIER_RENDERABLE_IMAGE_CONTENT_TYPE: "image/png";
```


### `./advanced` — `HappierRenderableImageAdmission` (type)

Declared by `dist/presentation/content/renderableImage.d.ts` as `HappierRenderableImageAdmission`.

```ts
type HappierRenderableImageAdmission = Readonly<{
    admitted: true;
    source: HappierRenderableImageSource;
}> | Readonly<{
    admitted: false;
    refusal: HappierRenderableImageRefusal;
}>;
```


### `./advanced` — `HappierRenderableImageRefusal` (type)

Declared by `dist/presentation/content/renderableImage.d.ts` as `HappierRenderableImageRefusal`.

```ts
type HappierRenderableImageRefusal = Readonly<{
    code: 'plugin_renderable_image_empty' | 'plugin_renderable_image_not_png' | 'plugin_renderable_image_too_many_bytes' | 'plugin_renderable_image_too_many_pixels';
    severity: 'warning';
    message: string;
    details: Readonly<{
        byteLength: number;
        limit?: number;
        pixels?: number;
    }>;
}>;
```


### `./advanced` — `HappierRenderableImageSource` (type)

Declared by `dist/presentation/content/renderableImage.d.ts` as `HappierRenderableImageSource`.

```ts
type HappierRenderableImageSource = Readonly<{
    uri: string;
}>;
```


### `./advanced` — `PluginHostApiProvider` (value)

Declared by `dist/hostApi/context.d.ts` as `PluginHostApiProvider`.

```ts
function PluginHostApiProvider(props: PluginHostApiProviderProps): import("react").FunctionComponentElement<PluginHostApiProviderInternalProps>;
```


### `./advanced` — `PluginHostApiProviderProps` (type)

Declared by `dist/hostApi/context.d.ts` as `PluginHostApiProviderProps`.

```ts
type PluginHostApiProviderProps = Readonly<{
    hostApi: PluginUiHostApi;
    children?: ReactNode;
}>;
```


### `./advanced` — `PluginUiProvider` (value)

Declared by `dist/components/PluginUiProvider.d.ts` as `PluginUiProvider`.

```ts
function PluginUiProvider(props: PluginUiProviderProps): import("react/jsx-runtime").JSX.Element;
```


### `./advanced` — `PluginUiProviderProps` (type)

Declared by `dist/components/PluginUiProvider.d.ts` as `PluginUiProviderProps`.

```ts
type PluginUiProviderProps = Readonly<{
    hostApi: PluginUiHostApi;
    context?: SurfaceContext;
    children?: ReactNode;
}>;
```


### `./advanced` — `PluginUiResourceAccountLifetime` (type)

Declared by `dist/hostApi/resourceStore.d.ts` as `PluginUiResourceAccountLifetime`.

```ts
type PluginUiResourceAccountLifetime = Readonly<{
    isCurrent(): boolean;
    onRetire(cancel: () => void): Disposable;
}>;
```


### `./advanced` — `PluginUiResourceClient` (type)

Declared by `dist/hostApi/resourceStore.d.ts` as `PluginUiResourceClient`.

```ts
type PluginUiResourceClient = Readonly<{
    readResource: PluginUiHostApi['readResource'];
    watchResource?: (...args: Parameters<PluginUiHostApi['watchResource']>) => Promise<Disposable & Readonly<{
        admittedDigest?: string;
    }>>;
    diagnostic?: PluginUiHostApi['diagnostic'];
}>;
```


### `./advanced` — `PluginUiResourceEntry` (type)

Declared by `dist/hostApi/resourceStore.d.ts` as `PluginUiResourceEntry`.

```ts
type PluginUiResourceEntry = Readonly<{
    getSnapshot(): PluginUiResourceSnapshot;
    subscribe(listener: () => void, live: boolean): () => void;
    refresh(): void;
}>;
```


### `./advanced` — `PluginUiResourceStore` (type)

Declared by `dist/hostApi/resourceStore.d.ts` as `PluginUiResourceStore`.

```ts
type PluginUiResourceStore = Readonly<{
    getEntry(resource: PluginUiResourceReference): PluginUiResourceEntry;
    dispose(): void;
}>;
```


### `./advanced` — `createPluginUiHostApiResourceClient` (value)

Declared by `dist/hostApi/resourceStore.d.ts` as `createPluginUiHostApiResourceClient`.

```ts
function createPluginUiHostApiResourceClient(hostApi: PluginUiHostApi): PluginUiResourceClient;
```


### `./advanced` — `createPluginUiResourceStore` (value)

Declared by `dist/hostApi/resourceStore.d.ts` as `createPluginUiResourceStore`.

```ts
function createPluginUiResourceStore(input: Readonly<{
    client: PluginUiResourceClient;
    accountLifetime?: PluginUiResourceAccountLifetime | null;
    pluginId?: string;
}>): PluginUiResourceStore;
```


### `./advanced` — `materializeHappierRenderableImage` (value)

Declared by `dist/presentation/content/renderableImage.d.ts` as `materializeHappierRenderableImage`.

```ts
function materializeHappierRenderableImage(bytes: Uint8Array): HappierRenderableImageAdmission;
```


### `./components` — `Action` (value)

Declared by `dist/components/Action.d.ts` as `Action`.

```ts
const Action: Readonly<{
    Execute: typeof ActionExecute;
    Copy: typeof ActionCopy;
    OpenExternal: typeof ActionOpenExternal;
    OpenSurface: typeof ActionOpenSurface;
    Refresh: typeof ActionRefresh;
}>;
```


### `./components` — `ActionCopyProps` (type)

Declared by `dist/components/Action.d.ts` as `ActionCopyProps`.

```ts
type ActionCopyProps = ActionChromeProps & Readonly<{
    value: string;
}>;
```


### `./components` — `ActionExecuteProps` (type)

Declared by `dist/components/Action.d.ts` as `ActionExecuteProps`.

```ts
type ActionExecuteProps<TAction extends PluginUiActionReference = PluginUiActionReference> = ActionChromeProps & Readonly<{
    action: TAction;
    input?: NoInfer<PluginUiActionInputFor<NoInfer<TAction>>>;
    onSettled?: (execution: PluginActionExecution<PluginUiActionResultFor<NoInfer<TAction>>>) => void;
}>;
```


### `./components` — `ActionFormFieldHint` (type)

Re-exported from another package as `ActionFormFieldHint`; that package owns the declaration.

```ts
// declared by another package — see its own declaration report
```


### `./components` — `ActionFormHints` (type)

Re-exported from another package as `ActionFormHints`; that package owns the declaration.

```ts
// declared by another package — see its own declaration report
```


### `./components` — `ActionOpenExternalProps` (type)

Declared by `dist/components/Action.d.ts` as `ActionOpenExternalProps`.

```ts
type ActionOpenExternalProps = ActionChromeProps & Readonly<{
    url: string;
}>;
```


### `./components` — `ActionOpenSurfaceProps` (type)

Declared by `dist/components/Action.d.ts` as `ActionOpenSurfaceProps`.

```ts
type ActionOpenSurfaceProps = ActionChromeProps & Readonly<{
    view: PluginReference;
    input?: JsonValue;
}>;
```


### `./components` — `ActionPanel` (value)

Declared by `dist/components/Action.d.ts` as `ActionPanel`.

```ts
const ActionPanel: typeof ActionPanelRoot & {
    Section: typeof ActionPanelSection;
};
```


### `./components` — `ActionPanelProps` (type)

Declared by `dist/components/Action.d.ts` as `ActionPanelProps`.

```ts
type ActionPanelProps = ActionGroupProps;
```


### `./components` — `ActionPanelSectionProps` (type)

Declared by `dist/components/Action.d.ts` as `ActionPanelSectionProps`.

```ts
type ActionPanelSectionProps = ActionGroupProps;
```


### `./components` — `ActionRefreshProps` (type)

Declared by `dist/components/Action.d.ts` as `ActionRefreshProps`.

```ts
type ActionRefreshProps = ActionChromeProps & Readonly<{
    onRefresh: () => unknown;
}>;
```


### `./components` — `Badge` (value)

Declared by `dist/components/Foundation.d.ts` as `Badge`.

```ts
function Badge({ tone, testID, children, ...text }: BadgeProps): ReactElement;
```


### `./components` — `BadgeProps` (type)

Declared by `dist/components/Foundation.d.ts` as `BadgeProps`.

```ts
type BadgeProps = AuthorText & Readonly<{
    tone?: HappierTone;
    testID?: string;
    children?: ReactNode;
}>;
```


### `./components` — `Banner` (value)

Declared by `dist/components/Foundation.d.ts` as `Banner`.

```ts
function Banner({ tone, title, titleKey, description, descriptionKey, ...props }: BannerProps): ReactElement;
```


### `./components` — `BannerProps` (type)

Declared by `dist/components/Foundation.d.ts` as `BannerProps`.

```ts
type BannerProps = Readonly<{
    tone?: HappierTone;
    title: string;
    titleKey?: string;
    description?: string;
    descriptionKey?: string;
    action?: ReactNode;
    testID?: string;
}>;
```


### `./components` — `BrandMark` (value)

Declared by `dist/components/Image.d.ts` as `BrandMark`.

```ts
function BrandMark({ pluginId, size, showName, externallyLabelled, testID }: BrandMarkProps): ReactElement;
```


### `./components` — `BrandMarkProps` (type)

Declared by `dist/components/Image.d.ts` as `BrandMarkProps`.

```ts
type BrandMarkProps = Readonly<{
    pluginId?: string;
    size?: ImageProps['size'];
    showName?: boolean;
    externallyLabelled?: boolean;
    testID?: string;
}>;
```


### `./components` — `Button` (value)

Declared by `dist/components/Button.d.ts` as `Button`.

```ts
function Button({ title, titleKey, accessibilityLabelKey, variant, disabled, busy, icon, accessibilityLabel, focusTarget, testID, onPress, children, }: ButtonProps): ReactElement;
```


### `./components` — `ButtonProps` (type)

Declared by `dist/components/Button.d.ts` as `ButtonProps`.

```ts
type ButtonProps = ButtonWithVisibleTitleProps | ButtonWithExplicitAccessibleNameProps;
```


### `./components` — `ButtonVariant` (type)

Declared by `dist/components/Button.d.ts` as `ButtonVariant`.

```ts
type ButtonVariant = 'primary' | 'secondary' | 'plain';
```


### `./components` — `Card` (value)

Declared by `dist/components/Surface.d.ts` as `Card`.

```ts
function Card({ padding, ...props }: CardProps): ReactElement;
```


### `./components` — `CardProps` (type)

Declared by `dist/components/Surface.d.ts` as `CardProps`.

```ts
type CardProps = SurfaceProps;
```


### `./components` — `CodeBlock` (value)

Declared by `dist/components/Content.d.ts` as `CodeBlock`.

```ts
function CodeBlock({ code, language, selectable, copyLabel, copiedLabel, testID, }: CodeBlockProps): ReactElement;
```


### `./components` — `CodeBlockProps` (type)

Declared by `dist/components/Content.d.ts` as `CodeBlockProps`.

```ts
type CodeBlockProps = Readonly<{
    code: string;
    language?: string;
    selectable?: boolean;
    copyLabel?: string;
    copiedLabel?: string;
    testID?: string;
}>;
```


### `./components` — `ContextMenu` (value)

Declared by `dist/components/Overlay.d.ts` as `ContextMenu`.

```ts
function ContextMenu(props: MenuProps): ReactElement;
```


### `./components` — `DiffViewer` (value)

Declared by `dist/components/Content.d.ts` as `DiffViewer`.

```ts
function DiffViewer({ unifiedDiff, filePath, label, testID, }: DiffViewerProps): ReactElement;
```


### `./components` — `DiffViewerProps` (type)

Declared by `dist/components/Content.d.ts` as `DiffViewerProps`.

```ts
type DiffViewerProps = Readonly<{
    unifiedDiff: string;
    filePath?: string;
    label: string;
    testID?: string;
}>;
```


### `./components` — `Divider` (value)

Declared by `dist/components/Foundation.d.ts` as `Divider`.

```ts
function Divider(props: DividerProps): ReactElement;
```


### `./components` — `DividerProps` (type)

Declared by `dist/components/Foundation.d.ts` as `DividerProps`.

```ts
type DividerProps = Readonly<{
    accessibilityLabel?: string;
    accessibilityLabelKey?: string;
    testID?: string;
}>;
```


### `./components` — `Dropdown` (value)

Declared by `dist/components/Overlay.d.ts` as `Dropdown`.

```ts
function Dropdown(props: MenuProps): ReactElement;
```


### `./components` — `EmptyState` (value)

Declared by `dist/components/State.d.ts` as `EmptyState`.

```ts
function EmptyState(props: EmptyStateProps): ReactElement;
```


### `./components` — `EmptyStateProps` (type)

Declared by `dist/components/State.d.ts` as `EmptyStateProps`.

```ts
type EmptyStateProps = StateCopyProps;
```


### `./components` — `ErrorState` (value)

Declared by `dist/components/State.d.ts` as `ErrorState`.

```ts
function ErrorState(props: ErrorStateProps): ReactElement;
```


### `./components` — `ErrorStateProps` (type)

Declared by `dist/components/State.d.ts` as `ErrorStateProps`.

```ts
type ErrorStateProps = StateCopyProps;
```


### `./components` — `Field` (value)

Declared by `dist/components/Form.d.ts` as `Field`.

```ts
function Field(props: FieldProps): ReactElement;
```


### `./components` — `FieldProps` (type)

Declared by `dist/components/Form.d.ts` as `FieldProps`.

```ts
type FieldProps = Readonly<{
    label: string;
    description?: string;
    required?: boolean;
    disabled?: boolean;
    issue?: string;
    testID?: string;
    children?: ReactNode;
}>;
```


### `./components` — `Form` (value)

Declared by `dist/components/Form.d.ts` as `Form`.

```ts
const Form: typeof FormRoot & {
    Field: typeof Field;
    TextField: typeof TextField;
    Toggle: typeof Toggle;
    Select: typeof Select;
    ValidationMessage: typeof ValidationMessage;
    Actions: typeof FormActions;
};
```


### `./components` — `FormActionsProps` (type)

Declared by `dist/components/Form.d.ts` as `FormActionsProps`.

```ts
type FormActionsProps = Readonly<{
    children?: ReactNode;
}>;
```


### `./components` — `FormProps` (type)

Declared by `dist/components/Form.d.ts` as `FormProps`.

```ts
type FormProps = Readonly<{
    hints: ActionFormHints;
    value: Readonly<Record<string, unknown>>;
    onChange: (value: Record<string, unknown>) => void;
    onSubmit: (value: Record<string, unknown>) => unknown;
    onCancel?: () => unknown;
    cancelLabel?: string;
    issues?: Readonly<Record<string, string | undefined>>;
    disabled?: boolean;
    busy?: boolean;
    testID?: string;
}>;
```


### `./components` — `Heading` (value)

Declared by `dist/components/Foundation.d.ts` as `Heading`.

```ts
function Heading({ level, focusTarget, testID, children, ...text }: HeadingProps): ReactElement;
```


### `./components` — `HeadingProps` (type)

Declared by `dist/components/Foundation.d.ts` as `HeadingProps`.

```ts
type HeadingProps = AuthorText & Readonly<{
    level?: 1 | 2 | 3 | 4 | 5 | 6;
    focusTarget?: PluginUiFocusTarget;
    testID?: string;
    children?: ReactNode;
}>;
```


### `./components` — `Icon` (value)

Declared by `dist/components/Icon.d.ts` as `Icon`.

```ts
function Icon({ name, size, tone, accessibilityLabel, testID }: IconProps): ReactElement;
```


### `./components` — `IconButton` (value)

Declared by `dist/components/Button.d.ts` as `IconButton`.

```ts
function IconButton({ accessibilityLabel, accessibilityLabelKey, icon, disabled, busy, selected, focusTarget, testID, onPress, }: IconButtonProps): ReactElement;
```


### `./components` — `IconButtonProps` (type)

Declared by `dist/components/Button.d.ts` as `IconButtonProps`.

```ts
type IconButtonProps = Readonly<{
    accessibilityLabel: string;
    accessibilityLabelKey?: string;
    icon: ReactNode;
    disabled?: boolean;
    busy?: boolean;
    selected?: boolean;
    focusTarget?: PluginUiFocusTarget;
    testID?: string;
    onPress: () => unknown;
}>;
```


### `./components` — `IconName` (type)

Declared by `dist/components/Icon.d.ts` as `IconName`.

```ts
type IconName = HappierIconName;
```


### `./components` — `IconProps` (type)

Declared by `dist/components/Icon.d.ts` as `IconProps`.

```ts
type IconProps = Readonly<{
    name: IconName;
    size?: HappierIconSize;
    tone?: HappierTone;
    accessibilityLabel?: string;
    testID?: string;
}>;
```


### `./components` — `Image` (value)

Declared by `dist/components/Image.d.ts` as `Image`.

```ts
function Image({ resource, size, accessibilityLabel, fallback, testID }: ImageProps): ReactElement;
```


### `./components` — `ImageProps` (type)

Declared by `dist/components/Image.d.ts` as `ImageProps`.

```ts
type ImageProps = Readonly<{
    resource: PluginUiResourceReference;
    size?: HappierImageSize;
    accessibilityLabel?: string;
    fallback?: string;
    testID?: string;
}>;
```


### `./components` — `Item` (value)

Declared by `dist/components/List.d.ts` as `Item`.

```ts
function Item(props: ListItemProps): ReactElement;
```


### `./components` — `ItemGroup` (value)

Declared by `dist/components/List.d.ts` as `ItemGroup`.

```ts
function ItemGroup(props: ItemGroupProps): ReactElement;
```


### `./components` — `ItemGroupProps` (type)

Declared by `dist/components/List.d.ts` as `ItemGroupProps`.

```ts
type ItemGroupProps = Readonly<{
    children?: ReactNode;
    accessibilityRole?: 'radiogroup';
    accessibilityLabel?: string;
    accessibilityLabelKey?: string;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `./components` — `ItemProps` (type)

Declared by `dist/components/List.d.ts` as `ItemProps`.

```ts
type ItemProps = Readonly<{
    children?: ReactNode;
    title?: string;
    subtitle?: string;
    detail?: string;
    titleNumberOfLines?: number;
    subtitleNumberOfLines?: number;
    detailNumberOfLines?: number;
    icon?: ReactNode;
    accessory?: ReactNode;
    accessoryOutsidePressable?: boolean;
    accessoryWraps?: boolean;
    tone?: HappierTone;
    onPress?: (event?: HappierGestureResponderEvent) => unknown;
    disabled?: boolean;
    busy?: boolean;
    selected?: boolean;
    accessibilityRole?: 'radio' | 'option' | 'button';
    accessibilityExpanded?: boolean;
    accessibilityPositionInSet?: number;
    accessibilitySetSize?: number;
    density?: 'comfortable' | 'cozy' | 'compact' | 'tight';
    showDivider?: boolean;
    accessibilityLabel?: string;
    accessibilityLabelKey?: string;
    accessibilityHint?: string;
    accessibilityHintKey?: string;
    testID?: string;
    style?: HappierStyleProp;
}> & ItemSecondaryActionsProps;
```


### `./components` — `Label` (value)

Declared by `dist/components/Foundation.d.ts` as `Label`.

```ts
function Label({ testID, children, ...text }: LabelProps): ReactElement;
```


### `./components` — `LabelProps` (type)

Declared by `dist/components/Foundation.d.ts` as `LabelProps`.

```ts
type LabelProps = AuthorText & Readonly<{
    testID?: string;
    children?: ReactNode;
}>;
```


### `./components` — `LayoutChangeEvent` (type)

Declared by `dist/components/Layout.d.ts` as `LayoutChangeEvent`.

```ts
type LayoutChangeEvent = HappierLayoutChangeEvent;
```


### `./components` — `LayoutGap` (type)

Declared by `dist/components/Layout.d.ts` as `LayoutGap`.

```ts
type LayoutGap = HappierLayoutGap;
```


### `./components` — `Link` (value)

Declared by `dist/components/Foundation.d.ts` as `Link`.

```ts
function Link({ title, titleKey, url, disabled, testID }: LinkProps): ReactElement;
```


### `./components` — `LinkProps` (type)

Declared by `dist/components/Foundation.d.ts` as `LinkProps`.

```ts
type LinkProps = Readonly<{
    title: string;
    titleKey?: string;
    url: string;
    disabled?: boolean;
    testID?: string;
}>;
```


### `./components` — `List` (value)

Declared by `dist/components/List.d.ts` as `List`.

```ts
const List: typeof ListRoot & {
    Section: typeof ListSection;
    Item: typeof ListItem;
    SelectionActionBar: typeof ListSelectionActionBar;
};
```


### `./components` — `ListAccessibilityPattern` (type)

Declared by `dist/components/List.d.ts` as `ListAccessibilityPattern`.

```ts
type ListAccessibilityPattern = 'listbox' | 'grid';
```


### `./components` — `ListBulkAction` (type)

Declared by `dist/components/ListMultiSelection.d.ts` as `ListBulkAction`.

```ts
type ListBulkAction = Readonly<{
    id: string;
    label?: string;
    labelKey?: string;
    labelFallback?: string;
    icon?: ReactNode;
    tone?: HappierTone;
    disabled?: boolean;
    testID?: string;
}>;
```


### `./components` — `ListHeaderContext` (type)

Declared by `dist/components/List.d.ts` as `ListHeaderContext`.

```ts
type ListHeaderContext<Item> = Readonly<{
    selectedItem: Item | null;
}>;
```


### `./components` — `ListItemProps` (type)

Declared by `dist/components/List.d.ts` as `ListItemProps`.

```ts
type ListItemProps = ItemProps;
```


### `./components` — `ListMultiSelectionActions` (type)

Declared by `dist/components/ListMultiSelection.d.ts` as `ListMultiSelectionActions`.

```ts
type ListMultiSelectionActions = HappierListMultiSelectionActions;
```


### `./components` — `ListMultiSelectionCapabilityProps` (type)

Declared by `dist/components/List.d.ts` as `ListMultiSelectionCapabilityProps`.

```ts
type ListMultiSelectionCapabilityProps<Item = unknown> = Readonly<{
    store: ListMultiSelectionStore;
    isItemSelectable?: (item: Item, index: number) => boolean;
    retainedSelectionKeys?: readonly ListMultiSelectionKey[];
}>;
```


### `./components` — `ListMultiSelectionKey` (type)

Declared by `dist/components/ListMultiSelection.d.ts` as `ListMultiSelectionKey`.

```ts
type ListMultiSelectionKey = HappierListMultiSelectionKey;
```


### `./components` — `ListMultiSelectionProvider` (value)

Declared by `dist/components/ListMultiSelection.d.ts` as `ListMultiSelectionProvider`.

```ts
function ListMultiSelectionProvider(props: ListMultiSelectionProviderProps): ReactElement;
```


### `./components` — `ListMultiSelectionProviderProps` (type)

Declared by `dist/components/ListMultiSelection.d.ts` as `ListMultiSelectionProviderProps`.

```ts
type ListMultiSelectionProviderProps = Readonly<{
    store: ListMultiSelectionStore | null;
    children?: ReactNode;
}>;
```


### `./components` — `ListMultiSelectionRow` (type)

Declared by `dist/components/ListMultiSelection.d.ts` as `ListMultiSelectionRow`.

```ts
type ListMultiSelectionRow = Readonly<{
    isSelectionMode: boolean;
    isSelected: boolean;
    isFocused: boolean;
    replace: () => void;
    toggle: () => void;
    selectRange: () => void;
    addRange: () => void;
    setFocused: () => void;
}>;
```


### `./components` — `ListMultiSelectionSnapshot` (type)

Declared by `dist/components/ListMultiSelection.d.ts` as `ListMultiSelectionSnapshot`.

```ts
type ListMultiSelectionSnapshot = HappierListMultiSelectionSnapshot;
```


### `./components` — `ListMultiSelectionStore` (type)

Declared by `dist/components/ListMultiSelection.d.ts` as `ListMultiSelectionStore`.

```ts
type ListMultiSelectionStore = HappierListMultiSelectionStore;
```


### `./components` — `ListProps` (type)

Declared by `dist/components/List.d.ts` as `ListProps`.

```ts
type ListProps<Item> = ListBaseProps & (VirtualizedListProps<Item> | StaticListProps);
```


### `./components` — `ListSearchProps` (type)

Declared by `dist/components/List.d.ts` as `ListSearchProps`.

```ts
type ListSearchProps<Item> = ListSearchBaseProps<Item> & (Readonly<{
    value: string;
    defaultValue?: never;
    onValueChange: (value: string) => void;
}> | Readonly<{
    value?: never;
    defaultValue?: string;
    onValueChange?: (value: string) => void;
}>);
```


### `./components` — `ListSectionData` (type)

Declared by `dist/components/List.d.ts` as `ListSectionData`.

```ts
type ListSectionData<Item> = Readonly<{
    key: string;
    title: string;
    data: readonly Item[];
}>;
```


### `./components` — `ListSectionProps` (type)

Declared by `dist/components/List.d.ts` as `ListSectionProps`.

```ts
type ListSectionProps = Readonly<{
    children?: ReactNode;
    title: string;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `./components` — `ListSelectionActionBar` (value)

Declared by `dist/components/ListMultiSelection.d.ts` as `ListSelectionActionBar`.

```ts
function ListSelectionActionBar(props: ListSelectionActionBarProps): ReactElement | null;
```


### `./components` — `ListSelectionActionBarProps` (type)

Declared by `dist/components/ListMultiSelection.d.ts` as `ListSelectionActionBarProps`.

```ts
type ListSelectionActionBarProps = Readonly<{
    actions: readonly ListBulkAction[];
    onAction: (actionId: string, keys: readonly ListMultiSelectionKey[]) => void;
    onDismiss?: () => void;
    accessibilityLabel?: string;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `./components` — `ListSelectionProps` (type)

Declared by `dist/components/List.d.ts` as `ListSelectionProps`.

```ts
type ListSelectionProps<Item = unknown> = ListSelectionBaseProps<Item> & (Readonly<{
    selectedKey: string | null;
    defaultSelectedKey?: never;
    onSelectedKeyChange: (key: string) => void;
}> | Readonly<{
    selectedKey?: never;
    defaultSelectedKey?: string | null;
    onSelectedKeyChange?: (key: string) => void;
}>);
```


### `./components` — `LoadingState` (value)

Declared by `dist/components/State.d.ts` as `LoadingState`.

```ts
function LoadingState(props: LoadingStateProps): ReactElement;
```


### `./components` — `LoadingStateProps` (type)

Declared by `dist/components/State.d.ts` as `LoadingStateProps`.

```ts
type LoadingStateProps = StateCopyProps;
```


### `./components` — `Markdown` (value)

Declared by `dist/components/Content.d.ts` as `Markdown`.

```ts
function Markdown({ value, selectable, testID }: MarkdownProps): ReactElement;
```


### `./components` — `MarkdownProps` (type)

Declared by `dist/components/Content.d.ts` as `MarkdownProps`.

```ts
type MarkdownProps = Readonly<{
    value: string;
    selectable?: boolean;
    testID?: string;
}>;
```


### `./components` — `Menu` (value)

Declared by `dist/components/Overlay.d.ts` as `Menu`.

```ts
function Menu(props: MenuProps): ReactElement;
```


### `./components` — `MenuGroup` (type)

Declared by `dist/components/Overlay.d.ts` as `MenuGroup`.

```ts
type MenuGroup = Readonly<{
    id: string;
    accessibilityLabel: string;
    items: readonly MenuItem[];
}>;
```


### `./components` — `MenuItem` (type)

Declared by `dist/components/Overlay.d.ts` as `MenuItem`.

```ts
type MenuItem = MenuItemBase & (Readonly<{
    kind?: 'action';
    checked?: never;
    radioGroupId?: never;
}> | Readonly<{
    kind: 'checkbox';
    checked: boolean;
    radioGroupId?: never;
}> | Readonly<{
    kind: 'radio';
    radioGroupId: string;
    checked?: never;
}>);
```


### `./components` — `MenuProps` (type)

Declared by `dist/components/Overlay.d.ts` as `MenuProps`.

```ts
type MenuProps = Omit<PopoverProps, 'children'> & MenuContentProps & Readonly<{
    radioGroups?: readonly MenuRadioGroup[];
    onSelect(id: string): void;
}>;
```


### `./components` — `MenuRadioGroup` (type)

Declared by `dist/components/Overlay.d.ts` as `MenuRadioGroup`.

```ts
type MenuRadioGroup = Readonly<{
    id: string;
    accessibilityLabel: string;
    selectedId: string | null;
}>;
```


### `./components` — `Metadata` (value)

Declared by `dist/components/Foundation.d.ts` as `Metadata`.

```ts
function Metadata(props: MetadataProps): ReactElement;
```


### `./components` — `MetadataEntry` (type)

Declared by `dist/components/Foundation.d.ts` as `MetadataEntry`.

```ts
type MetadataEntry = Readonly<{
    label: string;
    labelKey?: string;
    value: string;
    tone?: HappierTone;
    accessibilityLabel?: string;
    accessibilityLabelKey?: string;
    testID?: string;
}>;
```


### `./components` — `MetadataProps` (type)

Declared by `dist/components/Foundation.d.ts` as `MetadataProps`.

```ts
type MetadataProps = Readonly<{
    title?: string;
    titleKey?: string;
    entries: readonly MetadataEntry[];
    testID?: string;
}>;
```


### `./components` — `PluginAccessibilityFacts` (type)

Declared by `dist/components/PluginUiProvider.d.ts` as `PluginAccessibilityFacts`.

```ts
type PluginAccessibilityFacts = HappierUiAccessibility;
```


### `./components` — `PluginTranslate` (type)

Declared by `dist/components/PluginUiProvider.d.ts` as `PluginTranslate`.

```ts
type PluginTranslate = (key: string, fallback?: string, values?: PluginTranslationValues) => string;
```


### `./components` — `PluginTranslationValues` (type)

Declared by `dist/components/PluginUiProvider.d.ts` as `PluginTranslationValues`.

```ts
type PluginTranslationValues = Readonly<Record<string, string | number>>;
```


### `./components` — `PluginUiFocusTarget` (type)

Declared by `dist/components/Focus.d.ts` as `PluginUiFocusTarget`.

```ts
type PluginUiFocusTarget = Readonly<{
    focus(): boolean;
}>;
```


### `./components` — `PluginUiResourceState` (type)

Declared by `dist/components/State.d.ts` as `PluginUiResourceState`.

```ts
type PluginUiResourceState<Value = unknown> = Readonly<{
    status: 'idle' | 'loading';
}> | Readonly<{
    status: 'ready';
    value: Value;
}> | Readonly<{
    status: 'empty';
}> | Readonly<{
    status: 'unavailable' | 'stale' | 'complete';
    diagnostics?: readonly string[];
}> | Readonly<{
    status: 'error';
    code?: string;
    message?: string;
    diagnostics?: readonly string[];
}>;
```


### `./components` — `Popover` (value)

Declared by `dist/components/Overlay.d.ts` as `Popover`.

```ts
function Popover(props: PopoverProps): ReactElement;
```


### `./components` — `PopoverProps` (type)

Declared by `dist/components/Overlay.d.ts` as `PopoverProps`.

```ts
type PopoverProps = Readonly<{
    open: boolean;
    onOpenChange(open: boolean): void;
    trigger: string;
    triggerTextVariant?: HappierTextVariant;
    triggerTextTone?: HappierTone;
    triggerAccessibilityLabel: string;
    contentAccessibilityLabel?: string;
    children?: ReactNode;
    placement?: 'auto' | 'top' | 'bottom' | 'left' | 'right';
    disabled?: boolean;
    testID?: string;
    triggerTabIndex?: -1 | 0;
    focusReturnRef?: RefObject<unknown>;
}>;
```


### `./components` — `Progress` (value)

Declared by `dist/components/Foundation.d.ts` as `Progress`.

```ts
function Progress({ label, labelKey, ...props }: ProgressProps): ReactElement;
```


### `./components` — `ProgressProps` (type)

Declared by `dist/components/Foundation.d.ts` as `ProgressProps`.

```ts
type ProgressProps = Readonly<{
    value?: number;
    label: string;
    labelKey?: string;
    testID?: string;
}>;
```


### `./components` — `Row` (value)

Declared by `dist/components/Layout.d.ts` as `Row`.

```ts
function Row({ gap, focusTarget, ...props }: RowProps): ReactElement;
```


### `./components` — `RowProps` (type)

Declared by `dist/components/Layout.d.ts` as `RowProps`.

```ts
type RowProps = StackProps;
```


### `./components` — `Screen` (value)

Declared by `dist/components/Layout.d.ts` as `Screen`.

```ts
function Screen({ children, safeArea, focusTarget, ...props }: ScreenProps): ReactElement;
```


### `./components` — `ScreenProps` (type)

Declared by `dist/components/Layout.d.ts` as `ScreenProps`.

```ts
type ScreenProps = Readonly<{
    children?: ReactNode;
    safeArea?: boolean;
    focusTarget?: PluginUiFocusTarget;
    onLayout?: (event: LayoutChangeEvent) => void;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `./components` — `ScrollArea` (value)

Declared by `dist/components/Layout.d.ts` as `ScrollArea`.

```ts
function ScrollArea({ children, safeArea, ...props }: ScrollAreaProps): ReactElement;
```


### `./components` — `ScrollAreaProps` (type)

Declared by `dist/components/Layout.d.ts` as `ScrollAreaProps`.

```ts
type ScrollAreaProps = Readonly<{
    children?: ReactNode;
    horizontal?: boolean;
    keyboardShouldPersistTaps?: HappierKeyboardShouldPersistTaps;
    onScroll?: (event: HappierScrollEvent) => void;
    scrollEventThrottle?: number;
    onLayout?: (event: LayoutChangeEvent) => void;
    accessibilityLabel?: string;
    safeArea?: boolean;
    testID?: string;
    style?: HappierStyleProp;
    contentContainerStyle?: HappierStyleProp;
}>;
```


### `./components` — `Select` (value)

Declared by `dist/components/Form.d.ts` as `Select`.

```ts
function Select(props: SelectProps): ReactElement;
```


### `./components` — `SelectOption` (type)

Declared by `dist/components/Form.d.ts` as `SelectOption`.

```ts
type SelectOption = FormOption;
```


### `./components` — `SelectProps` (type)

Declared by `dist/components/Form.d.ts` as `SelectProps`.

```ts
type SelectProps = Readonly<{
    label: string;
    options: readonly SelectOption[];
    value?: FormOptionValue | readonly FormOptionValue[];
    multiple?: boolean;
    maxSelections?: number;
    minimumSelections?: number;
    required?: boolean;
    onChange: (value: FormOptionValue | readonly FormOptionValue[]) => void;
    disabled?: boolean;
    focusTarget?: PluginUiFocusTarget;
    testID?: string;
}>;
```


### `./components` — `Spinner` (value)

Declared by `dist/components/Spinner.d.ts` as `Spinner`.

```ts
function Spinner({ size, tone, accessibilityLabel, testID }: SpinnerProps): ReactElement;
```


### `./components` — `SpinnerProps` (type)

Declared by `dist/components/Spinner.d.ts` as `SpinnerProps`.

```ts
type SpinnerProps = Readonly<{
    size?: SpinnerSize;
    tone?: TextTone;
    accessibilityLabel?: string;
    testID?: string;
}>;
```


### `./components` — `SpinnerSize` (type)

Declared by `dist/components/Spinner.d.ts` as `SpinnerSize`.

```ts
type SpinnerSize = 'small' | 'large' | number;
```


### `./components` — `Stack` (value)

Declared by `dist/components/Layout.d.ts` as `Stack`.

```ts
function Stack({ gap, focusTarget, ...props }: StackProps): ReactElement;
```


### `./components` — `StackProps` (type)

Declared by `dist/components/Layout.d.ts` as `StackProps`.

```ts
type StackProps = Readonly<{
    children?: ReactNode;
    gap?: LayoutGap;
    wrap?: boolean;
    align?: HappierAlignment;
    justify?: HappierJustification;
    focusTarget?: PluginUiFocusTarget;
    onLayout?: (event: LayoutChangeEvent) => void;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `./components` — `State` (value)

Declared by `dist/components/State.d.ts` as `State`.

```ts
function State<Value>({ resource, loading, empty, error, children, }: StateProps<Value>): ReactElement | null;
```


### `./components` — `StateProps` (type)

Declared by `dist/components/State.d.ts` as `StateProps`.

```ts
type StateProps<Value> = Readonly<{
    resource?: PluginUiResourceState<Value>;
    loading?: ReactNode;
    empty?: ReactNode;
    error?: ReactNode | ((state: Extract<PluginUiResourceState<Value>, {
        status: 'error';
    }>) => ReactNode);
    children?: ReactNode | ((value: Value) => ReactNode);
}>;
```


### `./components` — `Status` (value)

Declared by `dist/components/Status.d.ts` as `Status`.

```ts
function Status({ tone, label, labelKey, pulsing, focusTarget, testID }: StatusProps): ReactElement;
```


### `./components` — `StatusProps` (type)

Declared by `dist/components/Status.d.ts` as `StatusProps`.

```ts
type StatusProps = Readonly<{
    tone: TextTone;
    label: string;
    labelKey?: string;
    pulsing?: boolean;
    focusTarget?: PluginUiFocusTarget;
    testID?: string;
}>;
```


### `./components` — `Surface` (value)

Declared by `dist/components/Surface.d.ts` as `Surface`.

```ts
function Surface(props: SurfaceProps): ReactElement;
```


### `./components` — `SurfacePadding` (type)

Declared by `dist/components/Surface.d.ts` as `SurfacePadding`.

```ts
type SurfacePadding = 'none' | 'small' | 'medium' | 'large';
```


### `./components` — `SurfaceProps` (type)

Declared by `dist/components/Surface.d.ts` as `SurfaceProps`.

```ts
type SurfaceProps = Readonly<{
    children?: ReactNode;
    tone?: SurfaceTone;
    padding?: SurfacePadding;
    testID?: string;
    onPress?: () => unknown;
    disabled?: boolean;
    accessibilityLabel?: string;
}>;
```


### `./components` — `SurfaceTone` (type)

Declared by `dist/components/Surface.d.ts` as `SurfaceTone`.

```ts
type SurfaceTone = 'surface' | 'muted';
```


### `./components` — `TabPanelActivity` (type)

Declared by `dist/components/Tabs.d.ts` as `TabPanelActivity`.

```ts
type TabPanelActivity = HappierTabPanelActivity;
```


### `./components` — `Tabs` (value)

Declared by `dist/components/Tabs.d.ts` as `Tabs`.

```ts
const Tabs: typeof TabsRoot & {
    Item: typeof TabsItem;
};
```


### `./components` — `TabsItemProps` (type)

Declared by `dist/components/Tabs.d.ts` as `TabsItemProps`.

```ts
type TabsItemProps = Readonly<{
    value: string;
    title: string;
    icon?: ReactNode;
    badge?: string;
    disabled?: boolean;
    retention?: HappierTabRetention;
    children?: ReactNode;
}>;
```


### `./components` — `TabsProps` (type)

Declared by `dist/components/Tabs.d.ts` as `TabsProps`.

```ts
type TabsProps = Readonly<{
    value: string;
    onValueChange: (value: string) => void;
    ariaLabel: string;
    testID?: string;
    children?: ReactNode;
}>;
```


### `./components` — `TargetedSurface` (value)

Declared by `dist/components/TargetedSurface.d.ts` as `TargetedSurface`.

```ts
function TargetedSurface<TInput extends JsonValue = JsonValue, TPointId extends string = string, TSurface extends PluginUiTargetedContributionSurfaceV1 = ContributionSurfaceHandle<TInput, TPointId>>({ surface, input, instanceKey, fallback }: TargetedSurfaceProps<TInput, TPointId, TSurface>): ReactElement | null;
```


### `./components` — `TargetedSurfaceProps` (type)

Declared by `dist/components/TargetedSurface.d.ts` as `TargetedSurfaceProps`.

```ts
type TargetedSurfaceProps<TInput extends JsonValue = JsonValue, TPointId extends string = string, TSurface extends PluginUiTargetedContributionSurfaceV1 = ContributionSurfaceHandle<TInput, TPointId>> = Readonly<{
    surface: TSurface;
    input: TargetedSurfaceInput<TSurface>;
    instanceKey?: string;
    fallback?: ReactNode;
}>;
```


### `./components` — `Text` (value)

Declared by `dist/components/Text.d.ts` as `Text`.

```ts
function Text({ value, valueKey, fallback, values, tone, variant, numberOfLines, selectable, accessibilityLabel, testID, children, }: TextProps): ReactElement;
```


### `./components` — `TextField` (value)

Declared by `dist/components/Form.d.ts` as `TextField`.

```ts
function TextField(props: TextFieldProps): ReactElement;
```


### `./components` — `TextFieldProps` (type)

Declared by `dist/components/Form.d.ts` as `TextFieldProps`.

```ts
type TextFieldProps = Readonly<{
    label: string;
    labelKey?: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    placeholderKey?: string;
    disabled?: boolean;
    required?: boolean;
    secure?: boolean;
    multiline?: boolean;
    keyboardType?: 'default' | 'url' | 'numeric';
    autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
    autoCorrect?: boolean;
    selection?: TextSelection;
    onSelectionChange?: (selection: TextSelection) => void;
    onSubmitEditing?: () => void;
    onCompositionChange?: (isComposing: boolean) => void;
    onEscape?: () => boolean;
    focusTarget?: PluginUiFocusTarget;
    testID?: string;
}>;
```


### `./components` — `TextProps` (type)

Declared by `dist/components/Text.d.ts` as `TextProps`.

```ts
type TextProps = Readonly<{
    value?: string;
    valueKey?: string;
    fallback?: string;
    values?: PluginTranslationValues;
    tone?: TextTone;
    variant?: TextVariant;
    numberOfLines?: number;
    selectable?: boolean;
    accessibilityLabel?: string;
    testID?: string;
    children?: ReactNode;
}>;
```


### `./components` — `TextSelection` (type)

Declared by `dist/components/Form.d.ts` as `TextSelection`.

```ts
type TextSelection = HappierTextSelection;
```


### `./components` — `TextTone` (type)

Declared by `dist/components/Text.d.ts` as `TextTone`.

```ts
type TextTone = HappierTone;
```


### `./components` — `TextVariant` (type)

Declared by `dist/components/Text.d.ts` as `TextVariant`.

```ts
type TextVariant = HappierTextVariant;
```


### `./components` — `Toggle` (value)

Declared by `dist/components/Form.d.ts` as `Toggle`.

```ts
function Toggle(props: ToggleProps): ReactElement;
```


### `./components` — `ToggleProps` (type)

Declared by `dist/components/Form.d.ts` as `ToggleProps`.

```ts
type ToggleProps = Readonly<{
    label: string;
    value: boolean;
    onChange: (value: boolean) => void;
    disabled?: boolean;
    testID?: string;
}>;
```


### `./components` — `UseListMultiSelectionControllerInput` (type)

Declared by `dist/components/ListMultiSelection.d.ts` as `UseListMultiSelectionControllerInput`.

```ts
type UseListMultiSelectionControllerInput = Readonly<{
    scopeKey: string;
    rows: 'collection';
    visibleOrderedKeys?: never;
    eligibleKeys?: never;
    enabled?: boolean;
}> | Readonly<{
    scopeKey: string;
    rows?: never;
    visibleOrderedKeys: readonly ListMultiSelectionKey[];
    eligibleKeys?: readonly ListMultiSelectionKey[] | ReadonlySet<ListMultiSelectionKey> | null;
    enabled?: boolean;
}>;
```


### `./components` — `ValidationMessage` (value)

Declared by `dist/components/Form.d.ts` as `ValidationMessage`.

```ts
function ValidationMessage({ message, testID }: ValidationMessageProps): ReactElement;
```


### `./components` — `ValidationMessageProps` (type)

Declared by `dist/components/Form.d.ts` as `ValidationMessageProps`.

```ts
type ValidationMessageProps = Readonly<{
    message: string;
    testID?: string;
}>;
```


### `./components` — `createListMultiSelectionStore` (value)

Declared by `dist/components/ListMultiSelection.d.ts` as `createListMultiSelectionStore`.

```ts
const createListMultiSelectionStore: (input: CreateHappierListMultiSelectionStateInput) => ListMultiSelectionStore;
```


### `./components` — `useListMultiSelectionController` (value)

Declared by `dist/components/ListMultiSelection.d.ts` as `useListMultiSelectionController`.

```ts
function useListMultiSelectionController(input: UseListMultiSelectionControllerInput): ListMultiSelectionStore;
```


### `./components` — `useListMultiSelectionRow` (value)

Declared by `dist/components/ListMultiSelection.d.ts` as `useListMultiSelectionRow`.

```ts
function useListMultiSelectionRow(key: ListMultiSelectionKey): ListMultiSelectionRow;
```


### `./components` — `useListMultiSelectionSnapshot` (value)

Declared by `dist/components/ListMultiSelection.d.ts` as `useListMultiSelectionSnapshot`.

```ts
function useListMultiSelectionSnapshot(): ListMultiSelectionSnapshot;
```


### `./components` — `useListMultiSelectionStoreSnapshot` (value)

Declared by `dist/components/ListMultiSelection.d.ts` as `useListMultiSelectionStoreSnapshot`.

```ts
function useListMultiSelectionStoreSnapshot(store: ListMultiSelectionStore | null): ListMultiSelectionSnapshot;
```


### `./components` — `useOptionalListMultiSelectionStore` (value)

Declared by `dist/components/ListMultiSelection.d.ts` as `useOptionalListMultiSelectionStore`.

```ts
function useOptionalListMultiSelectionStore(): ListMultiSelectionStore | null;
```


### `./components` — `usePluginAccessibility` (value)

Declared by `dist/components/PluginUiProvider.d.ts` as `usePluginAccessibility`.

```ts
function usePluginAccessibility(): PluginAccessibilityFacts;
```


### `./components` — `usePluginBrandDisplayName` (value)

Declared by `dist/components/Image.d.ts` as `usePluginBrandDisplayName`.

```ts
function usePluginBrandDisplayName(pluginId?: string): string | undefined;
```


### `./components` — `usePluginBrandDisplayNameResolver` (value)

Declared by `dist/components/Image.d.ts` as `usePluginBrandDisplayNameResolver`.

```ts
function usePluginBrandDisplayNameResolver(): (pluginId?: string) => string | undefined;
```


### `./components` — `usePluginTheme` (value)

Declared by `dist/components/PluginUiProvider.d.ts` as `usePluginTheme`.

```ts
function usePluginTheme(): PluginUiThemeV1;
```


### `./components` — `usePluginTranslation` (value)

Declared by `dist/components/PluginUiProvider.d.ts` as `usePluginTranslation`.

```ts
function usePluginTranslation(): PluginTranslate;
```


### `./components` — `usePluginUiFocusTarget` (value)

Declared by `dist/components/Focus.d.ts` as `usePluginUiFocusTarget`.

```ts
function usePluginUiFocusTarget(): PluginUiFocusTarget;
```


### `./components` — `useSurfaceContext` (value)

Declared by `dist/components/PluginUiProvider.d.ts` as `useSurfaceContext`.

```ts
function useSurfaceContext(): SurfaceContext;
```


### `./components` — `useTabPanelActivity` (value)

Declared by `dist/components/Tabs.d.ts` as `useTabPanelActivity`.

```ts
function useTabPanelActivity(): TabPanelActivity;
```


### `./data` — `PluginUiAccountCollectionForDefinition` (type)

Declared by `dist/data/types.d.ts` as `PluginUiAccountCollectionForDefinition`.

```ts
type PluginUiAccountCollectionForDefinition<TDefinition extends PluginAccountCollectionDefinition> = Pick<PluginAccountCollectionForDefinition<TDefinition>, 'identityTag' | 'get' | 'put' | 'delete' | 'query' | 'batch' | 'limits' | 'measureBatch'>;
```


### `./data` — `PluginUiAccountKv` (type)

Declared by `dist/data/types.d.ts` as `PluginUiAccountKv`.

```ts
type PluginUiAccountKv = AccountKvService;
```


### `./data` — `PluginUiCollectionQueryFailure` (type)

Declared by `dist/data/index.d.ts` as `PluginUiCollectionQueryFailure`.

```ts
type PluginUiCollectionQueryFailure = PluginCollectionUiQueryErrorV1 | Error;
```


### `./data` — `PluginUiCollectionQueryInput` (type)

Declared by `dist/data/types.d.ts` as `PluginUiCollectionQueryInput`.

```ts
type PluginUiCollectionQueryInput = Readonly<{
    collectionId: PluginCollectionUiQueryRequestV1['collectionId'];
    uiQueryId: PluginCollectionUiQueryRequestV1['uiQueryId'];
    parameters: PluginCollectionUiQueryRequestV1['parameters'];
    signal?: AbortSignal;
}>;
```


### `./data` — `PluginUiCollectionQueryPager` (type)

Declared by `dist/data/types.d.ts` as `PluginUiCollectionQueryPager`.

```ts
type PluginUiCollectionQueryPager = Readonly<{
    getSnapshot(): PluginUiCollectionQuerySnapshot;
    subscribe(listener: () => void): () => void;
    refresh(): Promise<void>;
    loadMore(): Promise<void>;
    dispose(): void;
}>;
```


### `./data` — `PluginUiCollectionQueryResult` (type)

Declared by `dist/data/index.d.ts` as `PluginUiCollectionQueryResult`.

```ts
type PluginUiCollectionQueryResult = Readonly<{
    rows: PluginUiCollectionQuerySnapshot['rows'];
    hasMore: boolean;
    status: PluginUiCollectionQuerySnapshot['status'];
    error?: PluginUiCollectionQueryFailure;
    refresh(): Promise<void>;
    loadMore(): Promise<void>;
}>;
```


### `./data` — `PluginUiCollectionQuerySnapshot` (type)

Declared by `dist/data/types.d.ts` as `PluginUiCollectionQuerySnapshot`.

```ts
type PluginUiCollectionQuerySnapshot = Readonly<{
    rows: readonly PluginCollectionUiQueryResultV1['rows'][number][];
    hasMore: boolean;
    status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
    error?: PluginCollectionUiQueryErrorV1;
}>;
```


### `./data` — `PluginUiDataClient` (type)

Declared by `dist/data/types.d.ts` as `PluginUiDataClient`.

```ts
type PluginUiDataClient = Readonly<{
    collection<TDefinition extends PluginAccountCollectionDefinition>(definition: TDefinition): PluginUiAccountCollectionForDefinition<TDefinition>;
    openCollectionQuery(input: PluginUiCollectionQueryInput): Promise<PluginUiCollectionQueryPager>;
    readonly accountKv: PluginUiAccountKv;
}>;
```


### `./data` — `usePluginAccountKv` (value)

Declared by `dist/data/index.d.ts` as `usePluginAccountKv`.

```ts
function usePluginAccountKv(): PluginUiAccountKv;
```


### `./data` — `usePluginCollectionQuery` (value)

Declared by `dist/data/index.d.ts` as `usePluginCollectionQuery`.

```ts
function usePluginCollectionQuery(collectionId: PluginCollectionUiQueryRequestV1['collectionId'], uiQueryId: PluginCollectionUiQueryRequestV1['uiQueryId'], parameters?: PluginCollectionUiQueryRequestV1['parameters']): PluginUiCollectionQueryResult;
```


### `./data` — `usePluginUiDataClient` (value)

Declared by `dist/data/context.d.ts` as `usePluginUiDataClient`.

```ts
function usePluginUiDataClient(): PluginUiDataClient;
```


### `./data` — `usePluginUiDataClientOrNull` (value)

Declared by `dist/data/context.d.ts` as `usePluginUiDataClientOrNull`.

```ts
function usePluginUiDataClientOrNull(): PluginUiDataClient | null;
```


### `./environment` — `HAPPIER_ANDROID_MINIMUM_INTERACTIVE_TARGET_SIZE` (value)

Declared by `dist/environment/interactiveTarget.d.ts` as `HAPPIER_ANDROID_MINIMUM_INTERACTIVE_TARGET_SIZE`.

```ts
const HAPPIER_ANDROID_MINIMUM_INTERACTIVE_TARGET_SIZE: 48;
```


### `./environment` — `HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE` (value)

Declared by `dist/environment/interactiveTarget.d.ts` as `HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE`.

```ts
const HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE: 44;
```


### `./environment` — `HappierUiAccessibility` (type)

Declared by `dist/environment/types.d.ts` as `HappierUiAccessibility`.

```ts
type HappierUiAccessibility = Readonly<{
    textScale: number;
    reducedMotion: boolean;
    screenReaderEnabled: boolean;
    contrast: 'normal' | 'high';
}>;
```


### `./environment` — `HappierUiEdgeInsets` (type)

Declared by `dist/environment/types.d.ts` as `HappierUiEdgeInsets`.

```ts
type HappierUiEdgeInsets = Readonly<{
    top: number;
    right: number;
    bottom: number;
    left: number;
}>;
```


### `./environment` — `HappierUiEnvironment` (type)

Declared by `dist/environment/types.d.ts` as `HappierUiEnvironment`.

```ts
type HappierUiEnvironment = Readonly<{
    theme: PluginUiThemeV1;
    localization: HappierUiLocalization;
    accessibility: HappierUiAccessibility;
    platform: HappierUiPlatformFacts;
    insets: HappierUiInsets;
}>;
```


### `./environment` — `HappierUiEnvironmentProvider` (value)

Declared by `dist/environment/context.d.ts` as `HappierUiEnvironmentProvider`.

```ts
function HappierUiEnvironmentProvider({ environment, children, }: HappierUiEnvironmentProviderProps): import("react/jsx-runtime").JSX.Element;
```


### `./environment` — `HappierUiEnvironmentProviderProps` (type)

Declared by `dist/environment/context.d.ts` as `HappierUiEnvironmentProviderProps`.

```ts
type HappierUiEnvironmentProviderProps = Readonly<{
    environment: HappierUiEnvironment;
    children?: ReactNode;
}>;
```


### `./environment` — `HappierUiInsets` (type)

Declared by `dist/environment/types.d.ts` as `HappierUiInsets`.

```ts
type HappierUiInsets = Readonly<{
    safeArea: HappierUiEdgeInsets;
}>;
```


### `./environment` — `HappierUiLocalization` (type)

Declared by `dist/environment/types.d.ts` as `HappierUiLocalization`.

```ts
type HappierUiLocalization = Readonly<{
    locale: string;
    direction: HappierUiTextDirection;
    translate: (key: string, fallback?: string) => string;
}>;
```


### `./environment` — `HappierUiPlatformFacts` (type)

Declared by `dist/environment/types.d.ts` as `HappierUiPlatformFacts`.

```ts
type HappierUiPlatformFacts = Readonly<{
    platform: PluginUiPlatform;
    colorScheme: 'light' | 'dark';
}>;
```


### `./environment` — `HappierUiPlatformProvider` (value)

Declared by `dist/environment/context.d.ts` as `HappierUiPlatformProvider`.

```ts
function HappierUiPlatformProvider({ platform, children, }: HappierUiPlatformProviderProps): import("react/jsx-runtime").JSX.Element;
```


### `./environment` — `HappierUiPlatformProviderProps` (type)

Declared by `dist/environment/context.d.ts` as `HappierUiPlatformProviderProps`.

```ts
type HappierUiPlatformProviderProps = Readonly<{
    platform: HappierUiPlatformFacts;
    children?: ReactNode;
}>;
```


### `./environment` — `HappierUiTextDirection` (type)

Declared by `dist/environment/types.d.ts` as `HappierUiTextDirection`.

```ts
type HappierUiTextDirection = 'ltr' | 'rtl';
```


### `./environment` — `HappierUiTheme` (type)

Declared by `dist/environment/types.d.ts` as `HappierUiTheme`.

```ts
type HappierUiTheme = PluginUiThemeV1;
```


### `./environment` — `projectHappierUiEnvironment` (value)

Declared by `dist/environment/projectEnvironment.d.ts` as `projectHappierUiEnvironment`.

```ts
function projectHappierUiEnvironment(context: Pick<SurfaceContext, 'theme' | 'locale' | 'direction' | 'translations' | 'textScale' | 'reducedMotion' | 'screenReaderEnabled' | 'contrast' | 'platform' | 'colorScheme' | 'safeAreaInsets'>): HappierUiEnvironment;
```


### `./environment` — `resolveHappierMinimumInteractiveTargetSize` (value)

Declared by `dist/environment/interactiveTarget.d.ts` as `resolveHappierMinimumInteractiveTargetSize`.

```ts
function resolveHappierMinimumInteractiveTargetSize(platform: string): 44 | 48;
```


### `./environment` — `resolveHappierUiPresentationTheme` (value)

Declared by `dist/environment/context.d.ts` as `resolveHappierUiPresentationTheme`.

```ts
function resolveHappierUiPresentationTheme(theme: PluginUiThemeV1, contrast: HappierUiAccessibility['contrast']): PluginUiThemeV1;
```


### `./environment` — `useHappierNativeMinimumInteractiveTargetSize` (value)

Declared by `dist/environment/interactiveTarget.d.ts` as `useHappierNativeMinimumInteractiveTargetSize`.

```ts
function useHappierNativeMinimumInteractiveTargetSize(): 44 | 48 | undefined;
```


### `./environment` — `useHappierUiAccessibility` (value)

Declared by `dist/environment/context.d.ts` as `useHappierUiAccessibility`.

```ts
function useHappierUiAccessibility(): HappierUiAccessibility;
```


### `./environment` — `useHappierUiInsets` (value)

Declared by `dist/environment/context.d.ts` as `useHappierUiInsets`.

```ts
function useHappierUiInsets(): HappierUiInsets;
```


### `./environment` — `useHappierUiLocalization` (value)

Declared by `dist/environment/context.d.ts` as `useHappierUiLocalization`.

```ts
function useHappierUiLocalization(): HappierUiLocalization;
```


### `./environment` — `useHappierUiPlatform` (value)

Declared by `dist/environment/context.d.ts` as `useHappierUiPlatform`.

```ts
function useHappierUiPlatform(): HappierUiPlatformFacts;
```


### `./environment` — `useHappierUiTheme` (value)

Declared by `dist/environment/context.d.ts` as `useHappierUiTheme`.

```ts
function useHappierUiTheme(): PluginUiThemeV1;
```


### `./environment` — `useOptionalHappierUiAccessibility` (value)

Declared by `dist/environment/context.d.ts` as `useOptionalHappierUiAccessibility`.

```ts
function useOptionalHappierUiAccessibility(): HappierUiAccessibility | null;
```


### `./environment` — `useOptionalHappierUiLocalization` (value)

Declared by `dist/environment/context.d.ts` as `useOptionalHappierUiLocalization`.

```ts
function useOptionalHappierUiLocalization(): HappierUiLocalization | null;
```


### `./environment` — `useOptionalHappierUiPlatform` (value)

Declared by `dist/environment/context.d.ts` as `useOptionalHappierUiPlatform`.

```ts
function useOptionalHappierUiPlatform(): HappierUiPlatformFacts | null;
```


### `./environment` — `useOptionalHappierUiTheme` (value)

Declared by `dist/environment/context.d.ts` as `useOptionalHappierUiTheme`.

```ts
function useOptionalHappierUiTheme(): PluginUiThemeV1 | null;
```


### `./hostApi` — `ComposerContentHandleV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerContentHandleV1`.

```ts
type ComposerContentHandleV1 = Awaited<ReturnType<PluginUiHostApi['pickComposerMedia']>>;
```


### `./hostApi` — `ComposerContentInspectRequestV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerContentInspectRequestV1`.

```ts
type ComposerContentInspectRequestV1 = Parameters<PluginUiHostApi['inspectComposerContent']>[1];
```


### `./hostApi` — `ComposerContentInspectResultV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerContentInspectResultV1`.

```ts
type ComposerContentInspectResultV1 = Awaited<ReturnType<PluginUiHostApi['inspectComposerContent']>>;
```


### `./hostApi` — `ComposerContentPickMediaRequestV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerContentPickMediaRequestV1`.

```ts
type ComposerContentPickMediaRequestV1 = Parameters<PluginUiHostApi['pickComposerMedia']>[1];
```


### `./hostApi` — `ComposerContentService` (type)

Declared by `dist/composer/service.d.ts` as `ComposerContentService`.

```ts
interface ComposerContentService {
    pickMedia(request: ComposerContentPickMediaRequestV1, options?: ComposerRequestOptions): Promise<ComposerContentHandleV1>;
    inspect(handle: ComposerContentHandleV1, request: ComposerContentInspectRequestV1, options?: ComposerRequestOptions): Promise<ComposerContentInspectResultV1>;
    release(handle: ComposerContentHandleV1, options?: ComposerRequestOptions): Promise<void>;
}
```


### `./hostApi` — `ComposerDecorationResultV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerDecorationResultV1`.

```ts
type ComposerDecorationResultV1 = Awaited<ReturnType<PluginUiHostApi['setComposerDecorations']>>;
```


### `./hostApi` — `ComposerDecorationSetV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerDecorationSetV1`.

```ts
type ComposerDecorationSetV1 = SdkComposerDecorationSetV1;
```


### `./hostApi` — `ComposerFocusResultV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerFocusResultV1`.

```ts
type ComposerFocusResultV1 = Awaited<ReturnType<PluginUiHostApi['focusComposer']>>;
```


### `./hostApi` — `ComposerHandle` (type)

Declared by `dist/composer/service.d.ts` as `ComposerHandle`.

```ts
interface ComposerHandle {
    readonly ref: ComposerRefV1;
    readonly content: ComposerContentService;
    read(options?: ComposerRequestOptions): Promise<ComposerReadResultV1>;
    observe(listener: ComposerObserverV1, options?: ComposerRequestOptions): Promise<Disposable>;
    apply(transaction: ComposerTransactionV1, options?: ComposerRequestOptions): Promise<ComposerTransactionResultV1>;
    focus(options?: ComposerRequestOptions): Promise<ComposerFocusResultV1>;
    setDecorations(key: string, decorations: ComposerDecorationSetV1 | null, options?: ComposerRequestOptions): Promise<ComposerDecorationResultV1>;
    acquireInputLock(request: ComposerInputLockRequestV1, options?: ComposerRequestOptions): Promise<Disposable>;
}
```


### `./hostApi` — `ComposerInputLockRequestV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerInputLockRequestV1`.

```ts
type ComposerInputLockRequestV1 = Parameters<PluginUiHostApi['acquireComposerInputLock']>[1];
```


### `./hostApi` — `ComposerObserverV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerObserverV1`.

```ts
type ComposerObserverV1 = Parameters<PluginUiHostApi['watchComposer']>[1];
```


### `./hostApi` — `ComposerReadResultV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerReadResultV1`.

```ts
type ComposerReadResultV1 = Awaited<ReturnType<PluginUiHostApi['readComposer']>>;
```


### `./hostApi` — `ComposerRefV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerRefV1`.

```ts
type ComposerRefV1 = Parameters<PluginUiHostApi['readComposer']>[0];
```


### `./hostApi` — `ComposerRequestOptions` (type)

Declared by `dist/composer/types.d.ts` as `ComposerRequestOptions`.

```ts
type ComposerRequestOptions = Parameters<PluginUiHostApi['readComposer']>[1];
```


### `./hostApi` — `ComposerSnapshotV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerSnapshotV1`.

```ts
type ComposerSnapshotV1 = Extract<ComposerReadResultV1, Readonly<{
    status: 'ready';
}>>['snapshot'];
```


### `./hostApi` — `ComposerTransactionResultV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerTransactionResultV1`.

```ts
type ComposerTransactionResultV1 = Awaited<ReturnType<PluginUiHostApi['applyComposer']>>;
```


### `./hostApi` — `ComposerTransactionV1` (type)

Declared by `dist/composer/types.d.ts` as `ComposerTransactionV1`.

```ts
type ComposerTransactionV1 = Parameters<PluginUiHostApi['applyComposer']>[1];
```


### `./hostApi` — `ComposerViewStateV1` (type)

Declared by `dist/composer/hooks.d.ts` as `ComposerViewStateV1`.

```ts
type ComposerViewStateV1 = Readonly<{
    result: ComposerReadResultV1 | null;
    error: PluginError | null;
    pending: 'initial' | 'refresh' | null;
    refresh(): Promise<void>;
}>;
```


### `./hostApi` — `ComposersService` (type)

Declared by `dist/composer/service.d.ts` as `ComposersService`.

```ts
interface ComposersService {
    current(): ComposerHandle | null;
    active(options?: ComposerRequestOptions): Promise<ComposerHandle | null>;
    get(ref: ComposerRefV1, options?: ComposerRequestOptions): Promise<ComposerHandle | null>;
}
```


### `./hostApi` — `PluginActionExecution` (type)

Declared by `dist/hostApi/executeAction.d.ts` as `PluginActionExecution`.

```ts
type PluginActionExecution<Result = unknown> = Readonly<{
    status: 'idle';
}> | Readonly<{
    status: 'pending';
}> | Readonly<{
    status: 'success';
    result: Result;
}> | Readonly<{
    status: 'error';
    code: string;
    message: string;
    retryable: boolean;
}> | Readonly<{
    status: 'outcomeUnknown';
    code: string;
    message: string;
}>;
```


### `./hostApi` — `PluginActionExecutionController` (type)

Declared by `dist/hostApi/executeAction.d.ts` as `PluginActionExecutionController`.

```ts
type PluginActionExecutionController<Result, Input = JsonValue> = Readonly<{
    execution: PluginActionExecution<Result>;
    execute: (input?: Input, options?: PluginUiActionExecutionOptions) => Promise<PluginActionExecution<Result>>;
    reset: () => void;
}>;
```


### `./hostApi` — `PluginActionInput` (type)

Re-exported from another package as `ProtocolJsonValue`; that package owns the declaration.

```ts
// declared by another package — see its own declaration report
```


### `./hostApi` — `PluginActionInputFor` (type)

Re-exported from another package as `PluginUiActionInputFor`; that package owns the declaration.

```ts
// declared by another package — see its own declaration report
```


### `./hostApi` — `PluginActionReference` (type)

Re-exported from another package as `PluginUiActionReference`; that package owns the declaration.

```ts
// declared by another package — see its own declaration report
```


### `./hostApi` — `PluginActionResultFor` (type)

Re-exported from another package as `PluginUiActionResultFor`; that package owns the declaration.

```ts
// declared by another package — see its own declaration report
```


### `./hostApi` — `PluginUiEphemeralSharedScope` (type)

Declared by `dist/hostApi/ephemeralSharedScope.public.d.ts` as `PluginUiEphemeralSharedScope`.

```ts
type PluginUiEphemeralSharedScope = Readonly<{
    acquire<T>(localKey: string, create: () => Readonly<{
        value: T;
        dispose(): void;
    }>): PluginUiEphemeralSharedValueLease<T> | null;
}>;
```


### `./hostApi` — `PluginUiEphemeralSharedValueLease` (type)

Declared by `dist/hostApi/ephemeralSharedScope.public.d.ts` as `PluginUiEphemeralSharedValueLease`.

```ts
type PluginUiEphemeralSharedValueLease<T> = Readonly<{
    value: T;
    release(): void;
}>;
```


### `./hostApi` — `PluginUiHostApi` (type)

Re-exported from another package as `PluginUiHostApi`; that package owns the declaration.

```ts
// declared by another package — see its own declaration report
```


### `./hostApi` — `PluginUiResourceError` (type)

Declared by `dist/hostApi/resourceStore.d.ts` as `PluginUiResourceError`.

```ts
type PluginUiResourceError = Readonly<{
    code?: string;
    diagnostics?: readonly string[];
    message: string;
}>;
```


### `./hostApi` — `PluginUiResourceReference` (type)

Declared by `dist/hostApi/resourceStore.d.ts` as `PluginUiResourceReference`.

```ts
type PluginUiResourceReference = Parameters<PluginUiHostApi['readResource']>[0];
```


### `./hostApi` — `PluginUiResourceResult` (type)

Declared by `dist/hostApi/index.d.ts` as `PluginUiResourceResult`.

```ts
type PluginUiResourceResult = Readonly<{
    resource: PluginUiResourceSnapshot;
    refresh: () => void;
}>;
```


### `./hostApi` — `PluginUiResourceSnapshot` (type)

Declared by `dist/hostApi/resourceStore.d.ts` as `PluginUiResourceSnapshot`.

```ts
type PluginUiResourceSnapshot = Readonly<{
    value?: ResourceContent;
    digest?: string;
    freshness: 'unknown' | 'fresh' | 'stale';
    pending: 'idle' | 'initial' | 'refresh';
    error?: PluginUiResourceError;
    subscription: 'unsupported' | 'establishing' | 'live' | 'reconnecting' | 'ended';
}>;
```


### `./hostApi` — `ReviewCommentProposalQueryV1` (type)

Declared by `dist/hostApi/reviewCommentProposals.public.d.ts` as `ReviewCommentProposalQueryV1`.

```ts
type ReviewCommentProposalQueryV1 = Readonly<{
    linkedSessionIds: readonly string[];
    entry: Readonly<{
        kind: 'pullRequest';
        url?: string;
    }> | Readonly<{
        kind: 'issue';
        id: string;
    }>;
}>;
```


### `./hostApi` — `ReviewCommentProposalReadV1` (type)

Declared by `dist/hostApi/reviewCommentProposals.public.d.ts` as `ReviewCommentProposalReadV1`.

```ts
type ReviewCommentProposalReadV1 = Readonly<{
    status: 'loading' | 'ready' | 'failed';
    proposals: readonly ReviewCommentProposalWithBodyV1[];
}>;
```


### `./hostApi` — `ReviewCommentProposalWithBodyV1` (type)

Declared by `dist/hostApi/reviewCommentProposals.public.d.ts` as `ReviewCommentProposalWithBodyV1`.

```ts
type ReviewCommentProposalWithBodyV1 = Omit<ReviewCommentV1, 'body' | 'snapshot'> & Readonly<{
    body: string;
    snapshot: ReviewCommentSnapshotV1;
}>;
```


### `./hostApi` — `useComposer` (value)

Declared by `dist/composer/hooks.d.ts` as `useComposer`.

```ts
function useComposer(): ComposersService;
```


### `./hostApi` — `useComposerView` (value)

Declared by `dist/composer/hooks.d.ts` as `useComposerView`.

```ts
function useComposerView(handle: ComposerHandle | null): ComposerViewStateV1;
```


### `./hostApi` — `useExecutePluginAction` (value)

Declared by `dist/hostApi/executeAction.d.ts` as `useExecutePluginAction`.

```ts
function useExecutePluginAction<TAction extends PluginUiActionReference>(action: TAction, input?: NoInfer<PluginUiActionInputFor<NoInfer<TAction>>>): PluginActionExecutionController<PluginUiActionResultFor<NoInfer<TAction>>, PluginUiActionInputFor<NoInfer<TAction>>>;
```


### `./hostApi` — `useLivePluginResource` (value)

Declared by `dist/hostApi/index.d.ts` as `useLivePluginResource`.

```ts
function useLivePluginResource(resource: PluginUiResourceReference): PluginUiResourceResult;
```


### `./hostApi` — `usePluginHostApi` (value)

Declared by `dist/hostApi/context.d.ts` as `usePluginHostApi`.

```ts
function usePluginHostApi(): PluginUiHostApi;
```


### `./hostApi` — `usePluginResource` (value)

Declared by `dist/hostApi/index.d.ts` as `usePluginResource`.

```ts
function usePluginResource(resource: PluginUiResourceReference): PluginUiResourceResult;
```


### `./hostApi` — `usePluginSurfaceActivity` (value)

Declared by `dist/hostApi/context.d.ts` as `usePluginSurfaceActivity`.

```ts
function usePluginSurfaceActivity(): Readonly<{
    active: boolean;
}>;
```


### `./hostApi` — `usePluginUiEphemeralSharedScope` (value)

Declared by `dist/hostApi/context.d.ts` as `usePluginUiEphemeralSharedScope`.

```ts
function usePluginUiEphemeralSharedScope(): PluginUiEphemeralSharedScope | null;
```


### `./hostApi` — `useReviewCommentProposalsForEntry` (value)

Declared by `dist/hostApi/reviewCommentProposals.public.d.ts` as `useReviewCommentProposalsForEntry`.

```ts
function useReviewCommentProposalsForEntry(query: ReviewCommentProposalQueryV1): ReviewCommentProposalReadV1;
```


### `./presentation` — `CreateHappierListMultiSelectionStateInput` (type)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `CreateHappierListMultiSelectionStateInput`.

```ts
type CreateHappierListMultiSelectionStateInput = Readonly<{
    scopeKey: string;
    visibleOrderedKeys: readonly HappierListMultiSelectionKey[];
    eligibleKeys?: readonly HappierListMultiSelectionKey[] | ReadonlySet<HappierListMultiSelectionKey> | null;
}>;
```


### `./presentation` — `HAPPIER_ICON_NAMES` (value)

Declared by `dist/presentation/content/Icon.d.ts` as `HAPPIER_ICON_NAMES`.

```ts
const HAPPIER_ICON_NAMES: readonly PluginUiIconTokenV1[];
```


### `./presentation` — `HAPPIER_LIST_MULTI_SELECTION_INERT_ROW_SNAPSHOT` (value)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `HAPPIER_LIST_MULTI_SELECTION_INERT_ROW_SNAPSHOT`.

```ts
const HAPPIER_LIST_MULTI_SELECTION_INERT_ROW_SNAPSHOT: "0:0:0";
```


### `./presentation` — `HAPPIER_LIST_MULTI_SELECTION_INERT_SNAPSHOT` (value)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `HAPPIER_LIST_MULTI_SELECTION_INERT_SNAPSHOT`.

```ts
const HAPPIER_LIST_MULTI_SELECTION_INERT_SNAPSHOT: HappierListMultiSelectionSnapshot;
```


### `./presentation` — `HAPPIER_TONE_COLOR_TOKEN` (value)

Declared by `dist/presentation/semantics.d.ts` as `HAPPIER_TONE_COLOR_TOKEN`.

```ts
const HAPPIER_TONE_COLOR_TOKEN: {
    readonly neutral: 'text';
    readonly secondary: 'secondaryText';
    readonly muted: 'mutedText';
    readonly info: 'info';
    readonly success: 'success';
    readonly warning: 'warning';
    readonly danger: 'danger';
    readonly accent: 'accent';
};
```


### `./presentation` — `HappierActionFieldPresentation` (type)

Declared by `dist/presentation/form/actionInputFields.d.ts` as `HappierActionFieldPresentation`.

```ts
type HappierActionFieldPresentation<OptionValue = unknown> = Readonly<{
    kind: 'toggle';
    value: boolean;
}> | Readonly<{
    kind: 'select';
    value: OptionValue | readonly OptionValue[] | undefined;
    multiple: boolean;
}> | Readonly<{
    kind: 'text';
    value: string;
    secure: boolean;
    multiline: boolean;
    keyboardType: 'default' | 'url' | 'numeric';
    parseText(text: string): unknown;
}>;
```


### `./presentation` — `HappierActionPanel` (value)

Declared by `dist/presentation/interaction/ActionPanel.d.ts` as `HappierActionPanel`.

```ts
function HappierActionPanel({ title, children, testID, style }: HappierActionPanelProps): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierActionPanelProps` (type)

Declared by `dist/presentation/interaction/ActionPanel.d.ts` as `HappierActionPanelProps`.

```ts
type HappierActionPanelProps = Readonly<{
    title?: string;
    children?: ReactNode;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `./presentation` — `HappierActionPanelSection` (value)

Declared by `dist/presentation/interaction/ActionPanel.d.ts` as `HappierActionPanelSection`.

```ts
function HappierActionPanelSection({ title, children, testID, style }: HappierActionPanelSectionProps): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierActionPanelSectionProps` (type)

Declared by `dist/presentation/interaction/ActionPanel.d.ts` as `HappierActionPanelSectionProps`.

```ts
type HappierActionPanelSectionProps = Readonly<{
    title?: string;
    children?: ReactNode;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `./presentation` — `HappierBadge` (value)

Declared by `dist/presentation/content/Foundation.d.ts` as `HappierBadge`.

```ts
function HappierBadge(props: Readonly<{
    children?: ReactNode;
    color: string;
    backgroundColor: string;
    borderColor: string;
    radius: number;
    horizontalPadding: number;
    verticalPadding: number;
    testID?: string;
}>): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierBanner` (value)

Declared by `dist/presentation/content/Foundation.d.ts` as `HappierBanner`.

```ts
function HappierBanner(props: Readonly<{
    title: string;
    description?: string;
    tone: HappierTone;
    action?: ReactNode;
    theme: HappierUiTheme;
    testID?: string;
    style?: HappierStyleProp;
    onLayout?: (event: HappierLayoutChangeEvent) => void;
    renderContent?: (input: Readonly<{
        color: string;
        urgent: boolean;
    }>) => ReactNode;
    unstyled?: boolean;
}>): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierBrandMark` (value)

Declared by `dist/presentation/content/Image.d.ts` as `HappierBrandMark`.

```ts
function HappierBrandMark(props: HappierBrandMarkProps): ReactElement;
```


### `./presentation` — `HappierBrandMarkProps` (type)

Declared by `dist/presentation/content/Image.d.ts` as `HappierBrandMarkProps`.

```ts
type HappierBrandMarkProps = Readonly<{
    displayName: string;
    bytes?: Uint8Array;
    size?: HappierImageSize;
    showName?: boolean;
    theme: HappierUiTheme;
    colorScheme: HappierUiPlatformFacts['colorScheme'];
    testID?: string;
    externallyLabelled?: boolean;
    onDecodeError?: () => void;
}>;
```


### `./presentation` — `HappierCodeBlockBehaviorInput` (type)

Declared by `dist/presentation/content/CodeBlock.d.ts` as `HappierCodeBlockBehaviorInput`.

```ts
type HappierCodeBlockBehaviorInput = Readonly<{
    language?: string | null;
    showHeaderRow: boolean;
    showCopyButton: boolean;
    hasHeaderLeft: boolean;
    hasHeaderRight: boolean;
    onCopy: () => unknown;
    copiedDurationMs?: number;
}>;
```


### `./presentation` — `HappierDiffViewerRequest` (type)

Declared by `dist/presentation/content/DiffViewer.d.ts` as `HappierDiffViewerRequest`.

```ts
type HappierDiffViewerRequest = Readonly<{
    unifiedDiff: string;
    filePath?: string;
    testID?: string;
}>;
```


### `./presentation` — `HappierDivider` (value)

Declared by `dist/presentation/content/Foundation.d.ts` as `HappierDivider`.

```ts
function HappierDivider(props: Readonly<{
    color: string;
    accessibilityLabel?: string;
    testID?: string;
    style?: HappierStyleProp;
}>): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierField` (value)

Declared by `dist/presentation/form/Fields.d.ts` as `HappierField`.

```ts
function HappierField(props: HappierFieldProps): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierFieldProps` (type)

Declared by `dist/presentation/form/Fields.d.ts` as `HappierFieldProps`.

```ts
type HappierFieldProps = Readonly<{
    label: string;
    description?: string;
    required?: boolean;
    disabled?: boolean;
    issue?: string;
    children?: ReactNode;
    theme: HappierUiTheme;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `./presentation` — `HappierForm` (value)

Declared by `dist/presentation/form/Fields.d.ts` as `HappierForm`.

```ts
function HappierForm({ children, accessibilityLabel, busy, testID, style }: HappierFormProps): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierFormActions` (value)

Declared by `dist/presentation/form/Fields.d.ts` as `HappierFormActions`.

```ts
function HappierFormActions({ children, testID, style }: HappierFormActionsProps): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierFormActionsProps` (type)

Declared by `dist/presentation/form/Fields.d.ts` as `HappierFormActionsProps`.

```ts
type HappierFormActionsProps = Readonly<{
    children?: ReactNode;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `./presentation` — `HappierFormPendingInput` (type)

Declared by `dist/presentation/form/Fields.d.ts` as `HappierFormPendingInput`.

```ts
type HappierFormPendingInput = Readonly<{
    busy?: boolean;
    implicitPending?: boolean;
}>;
```


### `./presentation` — `HappierFormProps` (type)

Declared by `dist/presentation/form/Fields.d.ts` as `HappierFormProps`.

```ts
type HappierFormProps = Readonly<{
    children?: ReactNode;
    accessibilityLabel?: string;
    busy?: boolean;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `./presentation` — `HappierHeading` (value)

Declared by `dist/presentation/content/Foundation.d.ts` as `HappierHeading`.

```ts
function HappierHeading(props: Readonly<{
    children?: ReactNode;
    controlRef?: (instance: HappierFocusable | null) => void;
    level: 1 | 2 | 3 | 4 | 5 | 6;
    theme?: HappierUiTheme;
    testID?: string;
}>): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierIconName` (type)

Declared by `dist/presentation/content/Icon.d.ts` as `HappierIconName`.

```ts
type HappierIconName = PluginUiIconTokenV1;
```


### `./presentation` — `HappierIconSize` (type)

Declared by `dist/presentation/content/Icon.d.ts` as `HappierIconSize`.

```ts
type HappierIconSize = 'small' | 'medium' | 'large';
```


### `./presentation` — `HappierImageSize` (type)

Declared by `dist/presentation/content/Image.d.ts` as `HappierImageSize`.

```ts
type HappierImageSize = 'small' | 'medium' | 'large';
```


### `./presentation` — `HappierInfoState` (value)

Declared by `dist/presentation/state/InfoState.d.ts` as `HappierInfoState`.

```ts
function HappierInfoState({ children, action, testID, actionTestID, accessibilityRole, accessibilityLiveRegion, busy, }: HappierInfoStateProps): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierInfoStateProps` (type)

Declared by `dist/presentation/state/InfoState.d.ts` as `HappierInfoStateProps`.

```ts
type HappierInfoStateProps = Readonly<{
    children?: ReactNode;
    action?: ReactNode;
    testID?: string;
    actionTestID?: string;
    accessibilityRole?: 'alert';
    accessibilityLiveRegion?: 'none' | 'polite' | 'assertive';
    busy?: boolean;
}>;
```


### `./presentation` — `HappierInfoTile` (value)

Declared by `dist/presentation/state/InfoState.d.ts` as `HappierInfoTile`.

```ts
function HappierInfoTile({ icon, title, description, tone, paddingHorizontal, }: HappierInfoTileProps): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierInfoTileProps` (type)

Declared by `dist/presentation/state/InfoState.d.ts` as `HappierInfoTileProps`.

```ts
type HappierInfoTileProps = Readonly<{
    icon?: ReactNode;
    title?: ReactNode;
    description?: ReactNode;
    tone?: HappierTone;
    paddingHorizontal?: number;
}>;
```


### `./presentation` — `HappierItemBehavior` (type)

Declared by `dist/presentation/collection/semantics.d.ts` as `HappierItemBehavior`.

```ts
type HappierItemBehavior = Readonly<{
    accessibilityState?: HappierItemSemanticState;
    tabIndex: -1 | 0;
    interactive: boolean;
    secondaryActionsEnabled: boolean;
    density: HappierItemDensity;
    dividerVisible: boolean;
    selectionVisible: boolean;
    accessoryPlacement: 'inside' | 'outside';
    navigationAccessoryVisible: boolean;
}>;
```


### `./presentation` — `HappierItemBehaviorInput` (type)

Declared by `dist/presentation/collection/semantics.d.ts` as `HappierItemBehaviorInput`.

```ts
type HappierItemBehaviorInput = HappierItemSemanticInput & Readonly<{
    focused?: boolean;
    selectableItemCount?: number;
    density?: HappierItemDensity;
    hasPrimaryAction: boolean;
    hasSecondaryActions?: boolean;
    hasAccessory?: boolean;
    accessoryOutsidePressable?: boolean;
    showNavigationAccessory?: boolean;
    keepNavigationAccessoryWithAccessory?: boolean;
    showDivider?: boolean;
}>;
```


### `./presentation` — `HappierItemDensity` (type)

Declared by `dist/presentation/collection/semantics.d.ts` as `HappierItemDensity`.

```ts
type HappierItemDensity = 'comfortable' | 'cozy' | 'compact' | 'tight';
```


### `./presentation` — `HappierItemGroup` (value)

Declared by `dist/presentation/collection/ItemGroup.d.ts` as `HappierItemGroup`.

```ts
function HappierItemGroup(props: HappierItemGroupProps): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierItemGroupBehavior` (value)

Declared by `dist/presentation/collection/ItemGroup.d.ts` as `HappierItemGroupBehavior`.

```ts
function HappierItemGroupBehavior(props: HappierItemGroupBehaviorProps): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierItemGroupBehaviorProps` (type)

Declared by `dist/presentation/collection/ItemGroup.d.ts` as `HappierItemGroupBehaviorProps`.

```ts
type HappierItemGroupBehaviorProps = Readonly<{
    children?: React.ReactNode;
    accessibilityRole?: 'radiogroup';
    accessibilityLabel?: string;
    selectableItemCount: number;
    renderContent(projectedChildren: React.ReactNode): React.ReactNode;
}>;
```


### `./presentation` — `HappierItemGroupItemBehaviorInput` (type)

Declared by `dist/presentation/collection/ItemGroup.d.ts` as `HappierItemGroupItemBehaviorInput`.

```ts
type HappierItemGroupItemBehaviorInput = Readonly<{
    role?: 'radio' | 'option' | 'button';
    itemGroupRadioIndex?: number;
    disabled?: boolean;
    busy?: boolean;
}>;
```


### `./presentation` — `HappierItemGroupProps` (type)

Declared by `dist/presentation/collection/ItemGroup.d.ts` as `HappierItemGroupProps`.

```ts
type HappierItemGroupProps = Readonly<{
    children?: React.ReactNode;
    accessibilityRole?: 'radiogroup';
    accessibilityLabel?: string;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `./presentation` — `HappierItemGroupRadioFocusable` (type)

Declared by `dist/presentation/collection/ItemGroup.d.ts` as `HappierItemGroupRadioFocusable`.

```ts
type HappierItemGroupRadioFocusable = HappierFocusable;
```


### `./presentation` — `HappierItemGroupSelectionContext` (value)

Declared by `dist/presentation/collection/ItemGroup.d.ts` as `HappierItemGroupSelectionContext`.

```ts
const HappierItemGroupSelectionContext: React.Context<Readonly<{
    selectableItemCount: number;
    radioGroup?: HappierItemGroupRadioContext | null;
}> | null>;
```


### `./presentation` — `HappierItemOverflow` (value)

Declared by `dist/presentation/collection/ItemOverflow.d.ts` as `HappierItemOverflow`.

```ts
function HappierItemOverflow(props: HappierItemOverflowProps): ReactElement | null;
```


### `./presentation` — `HappierItemOverflowAction` (type)

Declared by `dist/presentation/collection/ItemOverflow.d.ts` as `HappierItemOverflowAction`.

```ts
type HappierItemOverflowAction = Readonly<{
    id: string;
    label: string;
    disabled?: boolean;
    icon?: ReactNode;
}>;
```


### `./presentation` — `HappierItemOverflowProps` (type)

Declared by `dist/presentation/collection/ItemOverflow.d.ts` as `HappierItemOverflowProps`.

```ts
type HappierItemOverflowProps = Readonly<{
    actions: readonly HappierItemOverflowAction[];
    secondaryActionsEnabled?: boolean;
    accessibilityLabel: string;
    onSelect(id: string): void;
    open?: boolean;
    onOpenChange?(open: boolean): void;
    focusReturnRef?: RefObject<unknown>;
    renderMenu(input: HappierItemOverflowRenderInput): ReactElement;
    testID?: string;
}>;
```


### `./presentation` — `HappierItemOverflowRenderInput` (type)

Declared by `dist/presentation/collection/ItemOverflow.d.ts` as `HappierItemOverflowRenderInput`.

```ts
type HappierItemOverflowRenderInput = Readonly<{
    open: boolean;
    onOpenChange(open: boolean): void;
    trigger: string;
    triggerAccessibilityLabel: string;
    testID?: string;
    disabled: boolean;
    triggerTabIndex?: -1 | 0;
    focusReturnRef?: RefObject<unknown>;
    actions: readonly HappierItemOverflowAction[];
    onSelect(id: string): void;
}>;
```


### `./presentation` — `HappierItemSemanticInput` (type)

Declared by `dist/presentation/collection/semantics.d.ts` as `HappierItemSemanticInput`.

```ts
type HappierItemSemanticInput = Readonly<{
    role?: HappierSelectableRole;
    selected?: boolean;
    disabled?: boolean;
    busy?: boolean;
    expanded?: boolean;
    groupedIndex?: number;
    tabStopIndex?: number | null;
    isTabStop?: boolean;
}>;
```


### `./presentation` — `HappierItemSemanticState` (type)

Declared by `dist/presentation/collection/semantics.d.ts` as `HappierItemSemanticState`.

```ts
type HappierItemSemanticState = Readonly<{
    checked?: boolean;
    selected?: boolean;
    disabled?: boolean;
    busy?: boolean;
    expanded?: boolean;
}>;
```


### `./presentation` — `HappierLabel` (value)

Declared by `dist/presentation/content/Foundation.d.ts` as `HappierLabel`.

```ts
function HappierLabel(props: Readonly<{
    children?: ReactNode;
    theme?: HappierUiTheme;
    testID?: string;
}>): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierLayoutChangeEvent` (type)

Declared by `dist/presentation/portableTypes.d.ts` as `HappierLayoutChangeEvent`.

```ts
type HappierLayoutChangeEvent = Readonly<{
    nativeEvent: Readonly<{
        layout: Readonly<{
            x: number;
            y: number;
            width: number;
            height: number;
        }>;
    }>;
}>;
```


### `./presentation` — `HappierLayoutGap` (type)

Declared by `dist/presentation/layout/layoutSemantics.d.ts` as `HappierLayoutGap`.

```ts
type HappierLayoutGap = 'none' | 'xsmall' | 'small' | 'medium' | 'large' | 'xlarge';
```


### `./presentation` — `HappierLayoutSpacing` (type)

Declared by `dist/presentation/layout/layoutSemantics.d.ts` as `HappierLayoutSpacing`.

```ts
type HappierLayoutSpacing = Readonly<Record<Exclude<HappierLayoutGap, 'none'>, number>>;
```


### `./presentation` — `HappierLink` (value)

Declared by `dist/presentation/content/Foundation.d.ts` as `HappierLink`.

```ts
function HappierLink(props: Readonly<{
    children?: ReactNode;
    label: string;
    disabled?: boolean;
    onPress: () => unknown;
    theme: HappierUiTheme;
    testID?: string;
}>): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierList` (value)

Declared by `dist/presentation/collection/List.d.ts` as `HappierList`.

```ts
function HappierList({ children, accessibilityLabel, testID, style, }: HappierListProps): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierListItem` (value)

Declared by `dist/presentation/collection/List.d.ts` as `HappierListItem`.

```ts
function HappierListItem({ children, title, subtitle, detail, titleNumberOfLines, subtitleNumberOfLines, detailNumberOfLines, icon, accessory, accessoryWraps, accessoryOutsidePressable, tone, onPress, onContextMenu, disabled, busy, selected, accessibilityRole, accessibilityExpanded, accessibilityPositionInSet, accessibilitySetSize, theme, minimumTouchTarget, density, showDivider, hasSecondaryActions, accessibilityLabel, accessibilityHint, testID, style, itemGroupRadioIndex, rovingCollectionItem, suppressListItemRole, accessibilityRowIndex, accessibilityRowCount, }: HappierListItemProps): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierListItemProps` (type)

Declared by `dist/presentation/collection/List.d.ts` as `HappierListItemProps`.

```ts
type HappierListItemProps = Readonly<{
    children?: ReactNode;
    title?: string;
    subtitle?: string;
    detail?: string;
    titleNumberOfLines?: number;
    subtitleNumberOfLines?: number;
    detailNumberOfLines?: number;
    icon?: ReactNode;
    accessory?: ReactNode;
    accessoryWraps?: boolean;
    accessoryOutsidePressable?: boolean;
    tone?: HappierTone;
    onPress?: (event?: HappierGestureResponderEvent) => unknown;
    onContextMenu?: (event: unknown) => void;
    disabled?: boolean;
    busy?: boolean;
    selected?: boolean;
    accessibilityRole?: 'radio' | 'option' | 'button';
    accessibilityExpanded?: boolean;
    accessibilityPositionInSet?: number;
    accessibilitySetSize?: number;
    theme?: HappierUiTheme;
    minimumTouchTarget?: number;
    density?: HappierItemDensity;
    showDivider?: boolean;
    hasSecondaryActions?: boolean;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    testID?: string;
    style?: HappierStyleProp;
    itemGroupRadioIndex?: number;
    rovingCollectionItem?: HappierRovingCollectionItem;
    suppressListItemRole?: boolean;
    accessibilityRowIndex?: number;
    accessibilityRowCount?: number;
}>;
```


### `./presentation` — `HappierListMultiSelectionAction` (type)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `HappierListMultiSelectionAction`.

```ts
type HappierListMultiSelectionAction = Readonly<{
    type: 'enter';
    key?: HappierListMultiSelectionKey | null;
}> | Readonly<{
    type: 'exit';
}> | Readonly<{
    type: 'clear';
}> | Readonly<{
    type: 'replace';
    key: HappierListMultiSelectionKey;
}> | Readonly<{
    type: 'toggle';
    key: HappierListMultiSelectionKey;
}> | Readonly<{
    type: 'selectRange';
    targetKey: HappierListMultiSelectionKey;
    add?: boolean;
}> | Readonly<{
    type: 'selectAllVisible';
}> | Readonly<{
    type: 'setSelectedKeys';
    keys: readonly HappierListMultiSelectionKey[];
}> | Readonly<{
    type: 'setFocusedKey';
    key: HappierListMultiSelectionKey | null;
}> | Readonly<{
    type: 'setVisibleOrder';
    visibleOrderedKeys: readonly HappierListMultiSelectionKey[];
    eligibleKeys?: readonly HappierListMultiSelectionKey[] | ReadonlySet<HappierListMultiSelectionKey> | null;
}> | Readonly<{
    type: 'resetScope';
    scopeKey: string;
    visibleOrderedKeys: readonly HappierListMultiSelectionKey[];
    eligibleKeys?: readonly HappierListMultiSelectionKey[] | ReadonlySet<HappierListMultiSelectionKey> | null;
}>;
```


### `./presentation` — `HappierListMultiSelectionActions` (type)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `HappierListMultiSelectionActions`.

```ts
type HappierListMultiSelectionActions = Readonly<{
    enter: (preselectKey?: HappierListMultiSelectionKey | null) => void;
    exit: () => void;
    clear: () => void;
    replaceWith: (key: HappierListMultiSelectionKey) => void;
    toggle: (key: HappierListMultiSelectionKey) => void;
    selectRange: (targetKey: HappierListMultiSelectionKey) => void;
    addRange: (targetKey: HappierListMultiSelectionKey) => void;
    selectAllVisible: () => void;
    setSelectedKeys: (keys: readonly HappierListMultiSelectionKey[]) => void;
    setFocusedKey: (key: HappierListMultiSelectionKey | null) => void;
    isSelected: (key: HappierListMultiSelectionKey) => boolean;
}>;
```


### `./presentation` — `HappierListMultiSelectionKey` (type)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `HappierListMultiSelectionKey`.

```ts
type HappierListMultiSelectionKey = string;
```


### `./presentation` — `HappierListMultiSelectionKeyboardInput` (type)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `HappierListMultiSelectionKeyboardInput`.

```ts
type HappierListMultiSelectionKeyboardInput = Readonly<{
    key: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    platform: HappierPointerPlatform;
    entries: readonly HappierRovingEntry[];
    currentIndex: number;
    rtl: boolean;
}>;
```


### `./presentation` — `HappierListMultiSelectionKeyboardIntent` (type)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `HappierListMultiSelectionKeyboardIntent`.

```ts
type HappierListMultiSelectionKeyboardIntent = Readonly<{
    kind: 'toggleFocused';
}> | Readonly<{
    kind: 'selectAllVisible';
}> | Readonly<{
    kind: 'exit';
}> | Readonly<{
    kind: 'extendRange';
    toIndex: number;
}>;
```


### `./presentation` — `HappierListMultiSelectionPointerAction` (type)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `HappierListMultiSelectionPointerAction`.

```ts
type HappierListMultiSelectionPointerAction = 'open' | 'toggle' | 'selectRange' | 'addRange';
```


### `./presentation` — `HappierListMultiSelectionPointerInput` (type)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `HappierListMultiSelectionPointerInput`.

```ts
type HappierListMultiSelectionPointerInput = Readonly<{
    isSelectionMode: boolean;
    platform: HappierPointerPlatform;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
}>;
```


### `./presentation` — `HappierListMultiSelectionRangeInput` (type)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `HappierListMultiSelectionRangeInput`.

```ts
type HappierListMultiSelectionRangeInput = Readonly<{
    visibleOrderedKeys: readonly HappierListMultiSelectionKey[];
    anchorKey: HappierListMultiSelectionKey | null;
    targetKey: HappierListMultiSelectionKey;
    eligibleKeys?: ReadonlySet<HappierListMultiSelectionKey> | null;
}>;
```


### `./presentation` — `HappierListMultiSelectionRowFlags` (type)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `HappierListMultiSelectionRowFlags`.

```ts
type HappierListMultiSelectionRowFlags = Readonly<{
    isSelectionMode: boolean;
    isSelected: boolean;
    isFocused: boolean;
}>;
```


### `./presentation` — `HappierListMultiSelectionRowsInput` (type)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `HappierListMultiSelectionRowsInput`.

```ts
type HappierListMultiSelectionRowsInput = Readonly<{
    visibleOrderedKeys: readonly HappierListMultiSelectionKey[];
    eligibleKeys?: readonly HappierListMultiSelectionKey[] | ReadonlySet<HappierListMultiSelectionKey> | null;
}>;
```


### `./presentation` — `HappierListMultiSelectionSnapshot` (type)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `HappierListMultiSelectionSnapshot`.

```ts
type HappierListMultiSelectionSnapshot = HappierListMultiSelectionState & Readonly<{
    count: number;
}>;
```


### `./presentation` — `HappierListMultiSelectionState` (type)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `HappierListMultiSelectionState`.

```ts
type HappierListMultiSelectionState = Readonly<{
    isSelectionMode: boolean;
    selectedKeys: ReadonlySet<HappierListMultiSelectionKey>;
    anchorKey: HappierListMultiSelectionKey | null;
    focusedKey: HappierListMultiSelectionKey | null;
    visibleOrderedKeys: readonly HappierListMultiSelectionKey[];
    eligibleKeys: ReadonlySet<HappierListMultiSelectionKey>;
    scopeKey: string;
    version: number;
}>;
```


### `./presentation` — `HappierListMultiSelectionStore` (type)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `HappierListMultiSelectionStore`.

```ts
type HappierListMultiSelectionStore = HappierListMultiSelectionActions & Readonly<{
    getSnapshot: () => HappierListMultiSelectionSnapshot;
    getRowSnapshot: (key: HappierListMultiSelectionKey) => string;
    subscribe: (listener: () => void) => () => void;
    setVisibleRows: (params: HappierListMultiSelectionRowsInput) => void;
    updateScope: (params: HappierListMultiSelectionRowsInput & Readonly<{
        scopeKey: string;
    }>) => void;
}>;
```


### `./presentation` — `HappierListProps` (type)

Declared by `dist/presentation/collection/List.d.ts` as `HappierListProps`.

```ts
type HappierListProps = Readonly<{
    children?: ReactNode;
    accessibilityLabel?: string;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `./presentation` — `HappierListSection` (value)

Declared by `dist/presentation/collection/List.d.ts` as `HappierListSection`.

```ts
function HappierListSection({ children, title, virtualizedCollectionRole, accessibilityRowIndex, accessibilityRowCount, testID, style, }: HappierListSectionProps): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierListSectionProps` (type)

Declared by `dist/presentation/collection/List.d.ts` as `HappierListSectionProps`.

```ts
type HappierListSectionProps = Readonly<{
    children?: ReactNode;
    title: string;
    virtualizedCollectionRole?: 'list' | 'listbox' | 'grid';
    accessibilityRowIndex?: number;
    accessibilityRowCount?: number;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `./presentation` — `HappierMarkdown` (value)

Declared by `dist/presentation/content/Markdown.d.ts` as `HappierMarkdown`.

```ts
function HappierMarkdown(input: HappierMarkdownProps): ReactElement;
```


### `./presentation` — `HappierMarkdownProps` (type)

Declared by `dist/presentation/content/Markdown.d.ts` as `HappierMarkdownProps`.

```ts
type HappierMarkdownProps = HappierMarkdownRenderInput & Readonly<{
    renderContent?: (input: HappierMarkdownRenderInput) => ReactElement;
}>;
```


### `./presentation` — `HappierMarkdownRenderInput` (type)

Declared by `dist/presentation/content/Markdown.d.ts` as `HappierMarkdownRenderInput`.

```ts
type HappierMarkdownRenderInput = Readonly<{
    value: string;
    selectable: boolean;
    testID?: string;
}>;
```


### `./presentation` — `HappierMenuContent` (type)

Declared by `dist/presentation/interaction/Menu.d.ts` as `HappierMenuContent`.

```ts
type HappierMenuContent<Item extends HappierMenuItemDescriptor = HappierMenuItemDescriptor> = Readonly<{
    items: readonly Item[];
    ungroupedEntries: readonly HappierMenuEntry<Item>[];
    groups: readonly HappierResolvedMenuGroup<Item>[];
}>;
```


### `./presentation` — `HappierMenuEntry` (type)

Declared by `dist/presentation/interaction/Menu.d.ts` as `HappierMenuEntry`.

```ts
type HappierMenuEntry<Item extends HappierMenuItemDescriptor = HappierMenuItemDescriptor> = Readonly<{
    item: Item;
    index: number;
}>;
```


### `./presentation` — `HappierMenuGroupDescriptor` (type)

Declared by `dist/presentation/interaction/Menu.d.ts` as `HappierMenuGroupDescriptor`.

```ts
type HappierMenuGroupDescriptor<Item extends HappierMenuItemDescriptor = HappierMenuItemDescriptor> = Readonly<{
    id: string;
    accessibilityLabel: string;
    items: readonly Item[];
}>;
```


### `./presentation` — `HappierMenuInteractionInput` (type)

Declared by `dist/presentation/interaction/Menu.d.ts` as `HappierMenuInteractionInput`.

```ts
type HappierMenuInteractionInput<Item extends HappierMenuInteractionItem> = Readonly<{
    items: readonly Item[];
    open?: boolean;
    initialSelectedId?: string | null;
    allowEmptySelection?: boolean;
    enableTypeahead?: boolean;
    resetKey?: unknown;
    onRequestClose(): void;
    getItemLabel(item: Item): string | undefined;
    onKeyboardSelectionChange?(index: number): void;
}>;
```


### `./presentation` — `HappierMenuItemDescriptor` (type)

Declared by `dist/presentation/interaction/Menu.d.ts` as `HappierMenuItemDescriptor`.

```ts
type HappierMenuItemDescriptor = Readonly<{
    id: string;
    label?: string;
    disabled?: boolean;
    kind?: 'action' | 'checkbox' | 'radio';
    checked?: boolean;
    radioGroupId?: string;
}>;
```


### `./presentation` — `HappierMenuKeyAction` (type)

Declared by `dist/presentation/interaction/Menu.d.ts` as `HappierMenuKeyAction`.

```ts
type HappierMenuKeyAction = Readonly<{
    kind: 'move';
    direction: -1 | 1;
}> | Readonly<{
    kind: 'edge';
    edge: 'start' | 'end';
}> | Readonly<{
    kind: 'activate';
}> | Readonly<{
    kind: 'close';
}> | Readonly<{
    kind: 'typeahead';
    value: string;
}> | Readonly<{
    kind: 'none';
}>;
```


### `./presentation` — `HappierMenuRadioGroupDescriptor` (type)

Declared by `dist/presentation/interaction/Menu.d.ts` as `HappierMenuRadioGroupDescriptor`.

```ts
type HappierMenuRadioGroupDescriptor = Readonly<{
    id: string;
    accessibilityLabel: string;
    selectedId: string | null;
}>;
```


### `./presentation` — `HappierMetadata` (value)

Declared by `dist/presentation/content/Foundation.d.ts` as `HappierMetadata`.

```ts
function HappierMetadata(props: Readonly<{
    title?: string;
    entries: readonly HappierMetadataEntry[];
    theme: HappierUiTheme;
    testID?: string;
}>): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierMetadataEntry` (type)

Declared by `dist/presentation/content/Foundation.d.ts` as `HappierMetadataEntry`.

```ts
type HappierMetadataEntry = Readonly<{
    label: string;
    value: string;
    tone?: HappierTone;
    accessibilityLabel?: string;
    testID?: string;
}>;
```


### `./presentation` — `HappierPointerModifiers` (type)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `HappierPointerModifiers`.

```ts
type HappierPointerModifiers = Readonly<{
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
}>;
```


### `./presentation` — `HappierPointerPlatform` (type)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `HappierPointerPlatform`.

```ts
type HappierPointerPlatform = 'macos' | 'ios' | 'windows' | 'linux' | 'android' | 'web';
```


### `./presentation` — `HappierPopoverPlacement` (type)

Declared by `dist/presentation/interaction/Menu.d.ts` as `HappierPopoverPlacement`.

```ts
type HappierPopoverPlacement = HappierResolvedPopoverPlacement | 'auto' | 'auto-vertical' | 'auto-horizontal';
```


### `./presentation` — `HappierPressable` (value)

Declared by `dist/presentation/interaction/Pressable.d.ts` as `HappierPressable`.

```ts
function HappierPressable({ onPress, onPressIn, onLongPress, onContextMenu, onKeyDown, onFocusChange, disabled, busy, invalid, errorMessageId, describedById, highlighted, selected, expanded, accessibilityPositionInSet, accessibilitySetSize, hasPopup, checked, accessibilityRole, webRole, accessibilityLabel, accessibilityHint, hitSlop, testID, controlRef, tabIndex, nativeID, controls, style, overlay, children, }: HappierPressableProps): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierPressableProps` (type)

Declared by `dist/presentation/interaction/Pressable.d.ts` as `HappierPressableProps`.

```ts
type HappierPressableProps = Readonly<{
    onPress: (event?: HappierGestureResponderEvent) => unknown;
    onPressIn?: (event?: HappierGestureResponderEvent) => void;
    onLongPress?: (event?: HappierGestureResponderEvent) => void;
    onContextMenu?: (event: unknown) => void;
    onKeyDown?: (key: string, event: unknown) => boolean;
    onFocusChange?: (focused: boolean) => void;
    disabled?: boolean;
    busy?: boolean;
    invalid?: boolean;
    errorMessageId?: string;
    describedById?: string;
    highlighted?: boolean;
    selected?: boolean;
    expanded?: boolean;
    accessibilityPositionInSet?: number;
    accessibilitySetSize?: number;
    hasPopup?: 'dialog' | 'menu';
    checked?: boolean;
    accessibilityRole?: HappierPressableRole;
    webRole?: 'menuitemcheckbox' | 'menuitemradio';
    accessibilityLabel?: string;
    accessibilityHint?: string;
    hitSlop?: number;
    testID?: string;
    controlRef?: (instance: HappierFocusable | null) => void;
    tabIndex?: -1 | 0;
    nativeID?: string;
    controls?: string;
    style?: HappierStyleProp | ((state: HappierPressableStyleState) => HappierStyleProp);
    overlay?: (state: HappierPressableState) => ReactNode;
    children?: ReactNode | ((state: HappierPressableState) => ReactNode);
}>;
```


### `./presentation` — `HappierPressableRole` (type)

Declared by `dist/presentation/interaction/Pressable.d.ts` as `HappierPressableRole`.

```ts
type HappierPressableRole = 'button' | 'checkbox' | 'link' | 'radio' | 'tab' | 'switch' | 'menuitem' | 'menuitemcheckbox' | 'menuitemradio' | 'option';
```


### `./presentation` — `HappierPressableState` (type)

Declared by `dist/presentation/interaction/Pressable.d.ts` as `HappierPressableState`.

```ts
type HappierPressableState = Readonly<{
    hovered: boolean;
    focused: boolean;
    highlighted: boolean;
    selected: boolean;
    busy: boolean;
    disabled: boolean;
}>;
```


### `./presentation` — `HappierPressableStyleState` (type)

Declared by `dist/presentation/interaction/Pressable.d.ts` as `HappierPressableStyleState`.

```ts
type HappierPressableStyleState = HappierPressableState & Readonly<{
    pressed: boolean;
}>;
```


### `./presentation` — `HappierProgress` (value)

Declared by `dist/presentation/content/Foundation.d.ts` as `HappierProgress`.

```ts
function HappierProgress(props: Readonly<{
    value?: number;
    label: string;
    theme: HappierUiTheme;
    testID?: string;
    style?: HappierStyleProp;
    pointerEvents?: 'auto' | 'box-none' | 'box-only' | 'none';
    renderFill?: (percentage: number) => ReactNode;
}>): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierResolvedMenuGroup` (type)

Declared by `dist/presentation/interaction/Menu.d.ts` as `HappierResolvedMenuGroup`.

```ts
type HappierResolvedMenuGroup<Item extends HappierMenuItemDescriptor = HappierMenuItemDescriptor> = Readonly<{
    id: string;
    accessibilityLabel: string;
    entries: readonly HappierMenuEntry<Item>[];
}>;
```


### `./presentation` — `HappierResolvedPopoverPlacement` (type)

Declared by `dist/presentation/interaction/Menu.d.ts` as `HappierResolvedPopoverPlacement`.

```ts
type HappierResolvedPopoverPlacement = 'top' | 'bottom' | 'left' | 'right';
```


### `./presentation` — `HappierRovingEntry` (type)

Declared by `dist/presentation/collection/semantics.d.ts` as `HappierRovingEntry`.

```ts
type HappierRovingEntry = Readonly<{
    disabled: boolean;
}>;
```


### `./presentation` — `HappierScreen` (value)

Declared by `dist/presentation/layout/Layout.d.ts` as `HappierScreen`.

```ts
function HappierScreen({ children, controlRef, onLayout, testID, style, safeAreaInsets }: HappierScreenProps): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierScreenProps` (type)

Declared by `dist/presentation/layout/Layout.d.ts` as `HappierScreenProps`.

```ts
type HappierScreenProps = Readonly<{
    children?: ReactNode;
    controlRef?: (instance: HappierFocusable | null) => void;
    onLayout?: (event: HappierLayoutChangeEvent) => void;
    testID?: string;
    style?: HappierStyleProp;
    safeAreaInsets?: Readonly<{
        top: number;
        right: number;
        bottom: number;
        left: number;
    }>;
}>;
```


### `./presentation` — `HappierScrollArea` (value)

Declared by `dist/presentation/layout/Layout.d.ts` as `HappierScrollArea`.

```ts
function HappierScrollArea({ children, accessibilityLabel, testID, style, contentContainerStyle, safeAreaInsets, keyboardShouldPersistTaps, ...scrollProps }: HappierScrollAreaProps): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierScrollAreaProps` (type)

Declared by `dist/presentation/layout/Layout.d.ts` as `HappierScrollAreaProps`.

```ts
type HappierScrollAreaProps = Readonly<{
    children?: ReactNode;
    horizontal?: boolean;
    keyboardShouldPersistTaps?: HappierKeyboardShouldPersistTaps;
    onScroll?: (event: HappierScrollEvent) => void;
    scrollEventThrottle?: number;
    onLayout?: (event: HappierLayoutChangeEvent) => void;
    accessibilityLabel?: string;
    testID?: string;
    style?: HappierStyleProp;
    contentContainerStyle?: HappierStyleProp;
    safeAreaInsets?: Readonly<{
        top: number;
        right: number;
        bottom: number;
        left: number;
    }>;
}>;
```


### `./presentation` — `HappierSelect` (value)

Declared by `dist/presentation/form/Fields.d.ts` as `HappierSelect`.

```ts
function HappierSelect<Value = string>(props: Readonly<{
    label: string;
    options: readonly HappierSelectOption<Value>[];
    value: Value | readonly Value[] | undefined;
    multiple?: boolean;
    maxSelections?: number;
    minimumSelections?: number;
    required?: boolean;
    onChange: (value: Value | readonly Value[]) => void;
    isEqual?: (left: Value, right: Value) => boolean;
    keyForOption?: (option: HappierSelectOption<Value>, index: number) => string;
    minimumTouchTarget?: number;
    disabled?: boolean;
    controlRef?: (instance: HappierFocusable | null) => void;
    theme: HappierUiTheme;
    testID?: string;
}>): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierSelectOption` (type)

Declared by `dist/presentation/form/Fields.d.ts` as `HappierSelectOption`.

```ts
type HappierSelectOption<Value = string> = Readonly<{
    value: Value;
    label: string;
    description?: string;
    disabled?: boolean;
    accessibilityLabel?: string;
    testID?: string;
}>;
```


### `./presentation` — `HappierSelectableRole` (type)

Declared by `dist/presentation/collection/semantics.d.ts` as `HappierSelectableRole`.

```ts
type HappierSelectableRole = 'radio' | 'option' | 'button' | undefined;
```


### `./presentation` — `HappierSpinner` (value)

Declared by `dist/presentation/feedback/Spinner.d.ts` as `HappierSpinner`.

```ts
function HappierSpinner(props: HappierSpinnerProps): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierSpinnerProps` (type)

Declared by `dist/presentation/feedback/Spinner.d.ts` as `HappierSpinnerProps`.

```ts
type HappierSpinnerProps = HappierActivityIndicatorHostProps & Readonly<{
    size?: HappierActivityIndicatorHostProps['size'];
    animationEnabled?: boolean;
    reducedMotion?: boolean;
}>;
```


### `./presentation` — `HappierStack` (value)

Declared by `dist/presentation/layout/Layout.d.ts` as `HappierStack`.

```ts
function HappierStack({ children, direction, gap, wrap, align, justify, controlRef, onLayout, testID, style, }: HappierStackProps): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierStackProps` (type)

Declared by `dist/presentation/layout/Layout.d.ts` as `HappierStackProps`.

```ts
type HappierStackProps = Readonly<{
    children?: ReactNode;
    controlRef?: (instance: HappierFocusable | null) => void;
    direction?: 'vertical' | 'horizontal';
    gap?: number;
    wrap?: boolean;
    align?: HappierAlignment;
    justify?: HappierJustification;
    onLayout?: (event: HappierLayoutChangeEvent) => void;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `./presentation` — `HappierStatus` (value)

Declared by `dist/presentation/status/Status.d.ts` as `HappierStatus`.

```ts
function HappierStatus(props: HappierStatusProps): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierStatusDot` (value)

Declared by `dist/presentation/status/StatusDot.d.ts` as `HappierStatusDot`.

```ts
function HappierStatusDot(props: HappierStatusDotProps): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierStatusDotProps` (type)

Declared by `dist/presentation/status/StatusDot.d.ts` as `HappierStatusDotProps`.

```ts
type HappierStatusDotProps = Readonly<{
    color: string;
    isPulsing?: boolean;
    size?: number;
    style?: HappierStyleProp;
    testID?: string;
    accessibilityLabel?: string;
    animationEnabled?: boolean;
    reducedMotion?: boolean;
}>;
```


### `./presentation` — `HappierStatusProps` (type)

Declared by `dist/presentation/status/Status.d.ts` as `HappierStatusProps`.

```ts
type HappierStatusProps = Readonly<{
    label: ReactNode;
    value?: ReactNode;
    tone: HappierTone;
    theme: HappierUiTheme;
    contrast?: HappierUiAccessibility['contrast'];
    isPulsing?: boolean;
    animationEnabled?: boolean;
    controlRef?: (instance: HappierFocusable | null) => void;
    testID?: string;
    accessibilityLiveRegion?: HappierAccessibilityLiveRegion;
    accessibilityLabel?: string;
}>;
```


### `./presentation` — `HappierSurface` (value)

Declared by `dist/presentation/layout/Surface.d.ts` as `HappierSurface`.

```ts
function HappierSurface({ children, testID, onPress, disabled, accessibilityLabel, style, pressableStyle, pressedStyle, }: HappierSurfaceProps): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierSurfaceProps` (type)

Declared by `dist/presentation/layout/Surface.d.ts` as `HappierSurfaceProps`.

```ts
type HappierSurfaceProps = Readonly<{
    children?: ReactNode;
    testID?: string;
    onPress?: () => unknown;
    disabled?: boolean;
    accessibilityLabel?: string;
    style?: HappierStyleProp;
    pressableStyle?: HappierStyleProp;
    pressedStyle?: HappierStyleProp;
}>;
```


### `./presentation` — `HappierTabDescriptor` (type)

Declared by `dist/presentation/navigation/Tabs.d.ts` as `HappierTabDescriptor`.

```ts
type HappierTabDescriptor = Readonly<{
    value: string;
    title: string;
    icon?: ReactNode;
    badge?: string;
    disabled?: boolean;
    retention?: HappierTabRetention;
    children?: ReactNode;
}>;
```


### `./presentation` — `HappierTabPanelActivity` (type)

Declared by `dist/presentation/navigation/Tabs.d.ts` as `HappierTabPanelActivity`.

```ts
type HappierTabPanelActivity = Readonly<{
    active: boolean;
    activeSignal: AbortSignal;
}>;
```


### `./presentation` — `HappierTabRetention` (type)

Declared by `dist/presentation/navigation/Tabs.d.ts` as `HappierTabRetention`.

```ts
type HappierTabRetention = 'retain' | 'discard';
```


### `./presentation` — `HappierTabs` (value)

Declared by `dist/presentation/navigation/Tabs.d.ts` as `HappierTabs`.

```ts
function HappierTabs(props: Readonly<{
    value: string;
    onValueChange: (value: string) => void;
    ariaLabel: string;
    children?: ReactNode;
    theme: HappierUiTheme;
    testID?: string;
}>): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierText` (value)

Declared by `dist/presentation/text/Text.d.ts` as `HappierText`.

```ts
const HappierText: import("react").NamedExoticComponent<Readonly<{
    children?: ReactNode;
    style?: HappierStyleProp;
    accessible?: boolean;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    accessibilityLiveRegion?: import("../portableTypes.js").HappierAccessibilityLiveRegion;
    accessibilityRole?: 'alert' | 'header' | 'link' | 'none' | 'text';
    allowFontScaling?: boolean;
    ellipsizeMode?: 'clip' | 'head' | 'middle' | 'tail';
    maxFontSizeMultiplier?: number | null;
    nativeID?: string;
    numberOfLines?: number;
    onLayout?: (event: import("../portableTypes.js").HappierLayoutChangeEvent) => void;
    onLongPress?: (event?: import("../portableTypes.js").HappierGestureResponderEvent) => void;
    onPress?: (event?: import("../portableTypes.js").HappierGestureResponderEvent) => void;
    selectable?: boolean;
    suppressHighlighting?: boolean;
    testID?: string;
}> & Readonly<{
    variant?: HappierTextVariant;
    tone?: HappierTone;
    selectable?: boolean;
    textScale?: number;
    scaleStyleEntry?: TextStyleEntryTransform;
    baseStyle?: HappierStyleProp;
    tabIndex?: 0 | -1;
}> & import("react").RefAttributes<unknown>>;
```


### `./presentation` — `HappierTextField` (value)

Declared by `dist/presentation/form/Fields.d.ts` as `HappierTextField`.

```ts
function HappierTextField(props: HappierTextFieldProps): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierTextFieldProps` (type)

Declared by `dist/presentation/form/Fields.d.ts` as `HappierTextFieldProps`.

```ts
type HappierTextFieldProps = Readonly<{
    label: string;
    value: string;
    onChangeText: (value: string) => void;
    placeholder?: string;
    disabled?: boolean;
    required?: boolean;
    secure?: boolean;
    multiline?: boolean;
    keyboardType?: 'default' | 'url' | 'numeric';
    autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
    autoCorrect?: boolean;
    selection?: HappierTextSelection;
    onSelectionChange?: (selection: HappierTextSelection) => void;
    onSubmitEditing?: () => void;
    onCompositionChange?: (isComposing: boolean) => void;
    onEscape?: () => boolean;
    minimumTouchTarget?: number;
    controlRef?: (instance: HappierFocusable | null) => void;
    theme: HappierUiTheme;
    testID?: string;
}>;
```


### `./presentation` — `HappierTextPresentation` (type)

Declared by `dist/presentation/text/Text.d.ts` as `HappierTextPresentation`.

```ts
type HappierTextPresentation = Readonly<{
    selectable: boolean;
    metricScale: number;
    allowHostFontScaling: boolean;
}>;
```


### `./presentation` — `HappierTextPresentationInput` (type)

Declared by `dist/presentation/text/Text.d.ts` as `HappierTextPresentationInput`.

```ts
type HappierTextPresentationInput = Readonly<{
    selectable?: boolean;
    textScale?: number;
}>;
```


### `./presentation` — `HappierTextProps` (type)

Declared by `dist/presentation/text/Text.d.ts` as `HappierTextProps`.

```ts
type HappierTextProps = HappierTextHostProps & Readonly<{
    variant?: HappierTextVariant;
    tone?: HappierTone;
    selectable?: boolean;
    textScale?: number;
    scaleStyleEntry?: TextStyleEntryTransform;
    baseStyle?: HappierStyleProp;
    tabIndex?: 0 | -1;
}>;
```


### `./presentation` — `HappierTextSelectabilityScope` (value)

Declared by `dist/presentation/text/Text.d.ts` as `HappierTextSelectabilityScope`.

```ts
function HappierTextSelectabilityScope({ selectable, children, }: HappierTextSelectabilityScopeProps): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierTextSelectabilityScopeProps` (type)

Declared by `dist/presentation/text/Text.d.ts` as `HappierTextSelectabilityScopeProps`.

```ts
type HappierTextSelectabilityScopeProps = Readonly<{
    selectable: boolean;
    children: ReactNode;
}>;
```


### `./presentation` — `HappierTextSelection` (type)

Declared by `dist/presentation/portableTypes.d.ts` as `HappierTextSelection`.

```ts
type HappierTextSelection = Readonly<{
    start: number;
    end: number;
}>;
```


### `./presentation` — `HappierTextVariant` (type)

Declared by `dist/presentation/semantics.d.ts` as `HappierTextVariant`.

```ts
type HappierTextVariant = 'body' | 'label' | 'title' | 'caption' | 'code';
```


### `./presentation` — `HappierToggle` (value)

Declared by `dist/presentation/form/Fields.d.ts` as `HappierToggle`.

```ts
function HappierToggle(props: Readonly<{
    label: string;
    value: boolean;
    onChange: (value: boolean) => void;
    disabled?: boolean;
    minimumTouchTarget?: number;
    theme: HappierUiTheme;
    testID?: string;
}>): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierTone` (type)

Declared by `dist/presentation/semantics.d.ts` as `HappierTone`.

```ts
type HappierTone = 'neutral' | 'secondary' | 'muted' | 'info' | 'success' | 'warning' | 'danger' | 'accent';
```


### `./presentation` — `HappierValidationMessage` (value)

Declared by `dist/presentation/form/Fields.d.ts` as `HappierValidationMessage`.

```ts
function HappierValidationMessage({ message, theme, testID, nativeID, accessibilityLiveRegion, }: HappierValidationMessageProps): import("react/jsx-runtime").JSX.Element;
```


### `./presentation` — `HappierValidationMessageProps` (type)

Declared by `dist/presentation/form/Fields.d.ts` as `HappierValidationMessageProps`.

```ts
type HappierValidationMessageProps = Readonly<{
    message: string;
    theme: HappierUiTheme;
    testID?: string;
    nativeID?: string;
    accessibilityLiveRegion?: HappierAccessibilityLiveRegion;
}>;
```


### `./presentation` — `HappierWebSpinnerPresentation` (type)

Declared by `dist/presentation/feedback/Spinner.d.ts` as `HappierWebSpinnerPresentation`.

```ts
type HappierWebSpinnerPresentation = Readonly<{
    accessibilityRole: 'progressbar';
    style: HappierWebSpinnerStyle;
}>;
```


### `./presentation` — `HappierWebSpinnerPresentationInput` (type)

Declared by `dist/presentation/feedback/Spinner.d.ts` as `HappierWebSpinnerPresentationInput`.

```ts
type HappierWebSpinnerPresentationInput = Readonly<{
    animating?: boolean;
    animationEnabled?: boolean;
    color?: unknown;
    hidesWhenStopped?: boolean;
    reducedMotion?: boolean;
    size?: HappierActivityIndicatorHostProps['size'];
}>;
```


### `./presentation` — `HappierWebSpinnerStyle` (type)

Declared by `dist/presentation/feedback/Spinner.d.ts` as `HappierWebSpinnerStyle`.

```ts
type HappierWebSpinnerStyle = Readonly<{
    alignSelf: 'center';
    animationDuration?: string;
    animationIterationCount?: 'infinite';
    animationName?: string;
    animationTimingFunction?: string;
    borderColor: string;
    borderRadius: number;
    borderTopColor: 'transparent';
    borderWidth: number;
    height: number;
    opacity: number;
    width: number;
    willChange?: string;
}>;
```


### `./presentation` — `ScaleTextStyleOptions` (type)

Declared by `dist/presentation/text/textStyleScale.d.ts` as `ScaleTextStyleOptions`.

```ts
type ScaleTextStyleOptions = Readonly<{
    transformEntry?: TextStyleEntryTransform;
}>;
```


### `./presentation` — `ScaledTextStyleMetrics` (type)

Declared by `dist/presentation/text/textStyleScale.d.ts` as `ScaledTextStyleMetrics`.

```ts
type ScaledTextStyleMetrics<T> = IsExactly<T, HappierStyleProp> extends true ? HappierStyleProp : T extends readonly unknown[] ? ScaledTextStyleArray<T> : T extends object ? {
    [Key in keyof T]: Key extends ScaledTextMetricKey ? ScaleTextMetricValue<T[Key]> : T[Key];
} : T;
```


### `./presentation` — `TextStyleEntryTransform` (type)

Declared by `dist/presentation/text/textStyleScale.d.ts` as `TextStyleEntryTransform`.

```ts
type TextStyleEntryTransform = <T extends object>(entry: T, textScale: number) => T;
```


### `./presentation` — `cloneStyleEntryPreservingOwnProps` (value)

Declared by `dist/presentation/text/textStyleScale.d.ts` as `cloneStyleEntryPreservingOwnProps`.

```ts
function cloneStyleEntryPreservingOwnProps<T extends object>(entry: T): T;
```


### `./presentation` — `createHappierListMultiSelectionStore` (value)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `createHappierListMultiSelectionStore`.

```ts
function createHappierListMultiSelectionStore(input: CreateHappierListMultiSelectionStateInput): HappierListMultiSelectionStore;
```


### `./presentation` — `createInitialHappierListMultiSelectionState` (value)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `createInitialHappierListMultiSelectionState`.

```ts
function createInitialHappierListMultiSelectionState(input: CreateHappierListMultiSelectionStateInput): HappierListMultiSelectionState;
```


### `./presentation` — `iconMatchedSpinnerSize` (value)

Declared by `dist/presentation/feedback/Spinner.d.ts` as `iconMatchedSpinnerSize`.

```ts
function iconMatchedSpinnerSize(iconSize: number): number;
```


### `./presentation` — `isHappierBannerUrgent` (value)

Declared by `dist/presentation/content/Foundation.d.ts` as `isHappierBannerUrgent`.

```ts
function isHappierBannerUrgent(tone: HappierTone): boolean;
```


### `./presentation` — `isHappierIconName` (value)

Declared by `dist/presentation/content/Icon.d.ts` as `isHappierIconName`.

```ts
function isHappierIconName(value: unknown): value is HappierIconName;
```


### `./presentation` — `isHappierTabSelected` (value)

Declared by `dist/presentation/navigation/Tabs.d.ts` as `isHappierTabSelected`.

```ts
function isHappierTabSelected(value: string, candidate: string): boolean;
```


### `./presentation` — `matchesHappierMenuQuery` (value)

Declared by `dist/presentation/interaction/Menu.d.ts` as `matchesHappierMenuQuery`.

```ts
function matchesHappierMenuQuery(input: Readonly<{
    label: string;
    description?: string;
    query: string;
}>): boolean;
```


### `./presentation` — `normalizeHappierCodeLanguage` (value)

Declared by `dist/presentation/content/CodeBlock.d.ts` as `normalizeHappierCodeLanguage`.

```ts
function normalizeHappierCodeLanguage(language: string | null | undefined): string | undefined;
```


### `./presentation` — `parseHappierListMultiSelectionRowSnapshot` (value)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `parseHappierListMultiSelectionRowSnapshot`.

```ts
function parseHappierListMultiSelectionRowSnapshot(rowSnapshot: string): HappierListMultiSelectionRowFlags;
```


### `./presentation` — `patchHappierActionInputPath` (value)

Declared by `dist/presentation/form/actionInputFields.d.ts` as `patchHappierActionInputPath`.

```ts
function patchHappierActionInputPath(input: InputRecord, path: string, value: unknown): Record<string, unknown>;
```


### `./presentation` — `readHappierActionInputPath` (value)

Declared by `dist/presentation/form/actionInputFields.d.ts` as `readHappierActionInputPath`.

```ts
function readHappierActionInputPath(input: InputRecord, path: string): unknown;
```


### `./presentation` — `readHappierPointerModifiers` (value)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `readHappierPointerModifiers`.

```ts
function readHappierPointerModifiers(event: unknown): HappierPointerModifiers;
```


### `./presentation` — `reduceHappierListMultiSelection` (value)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `reduceHappierListMultiSelection`.

```ts
function reduceHappierListMultiSelection(state: HappierListMultiSelectionState, action: HappierListMultiSelectionAction): HappierListMultiSelectionState;
```


### `./presentation` — `resolveHappierActionFieldPresentation` (value)

Declared by `dist/presentation/form/actionInputFields.d.ts` as `resolveHappierActionFieldPresentation`.

```ts
function resolveHappierActionFieldPresentation<OptionValue = unknown>(field: HappierActionInputField, value: unknown, selection?: OptionValue | readonly OptionValue[]): HappierActionFieldPresentation<OptionValue>;
```


### `./presentation` — `resolveHappierBrandFallback` (value)

Declared by `dist/presentation/content/Image.d.ts` as `resolveHappierBrandFallback`.

```ts
function resolveHappierBrandFallback(displayName: string): string;
```


### `./presentation` — `resolveHappierCodeBlockLayout` (value)

Declared by `dist/presentation/content/CodeBlock.d.ts` as `resolveHappierCodeBlockLayout`.

```ts
function resolveHappierCodeBlockLayout(input: Pick<HappierCodeBlockBehaviorInput, 'language' | 'showHeaderRow' | 'showCopyButton' | 'hasHeaderLeft' | 'hasHeaderRight'>): {
    readonly language: string | undefined;
    readonly shouldRenderHeaderRow: boolean;
    readonly shouldOverlayCopyButton: boolean;
};
```


### `./presentation` — `resolveHappierDiffViewerRequest` (value)

Declared by `dist/presentation/content/DiffViewer.d.ts` as `resolveHappierDiffViewerRequest`.

```ts
function resolveHappierDiffViewerRequest(input: HappierDiffViewerRequest): HappierDiffViewerRequest;
```


### `./presentation` — `resolveHappierFormPending` (value)

Declared by `dist/presentation/form/Fields.d.ts` as `resolveHappierFormPending`.

```ts
function resolveHappierFormPending({ busy, implicitPending, }: HappierFormPendingInput): boolean;
```


### `./presentation` — `resolveHappierIconSize` (value)

Declared by `dist/presentation/content/Icon.d.ts` as `resolveHappierIconSize`.

```ts
function resolveHappierIconSize(size?: HappierIconSize): number;
```


### `./presentation` — `resolveHappierImagePixels` (value)

Declared by `dist/presentation/content/Image.d.ts` as `resolveHappierImagePixels`.

```ts
function resolveHappierImagePixels(size: HappierImageSize | undefined): number;
```


### `./presentation` — `resolveHappierItemBehavior` (value)

Declared by `dist/presentation/collection/semantics.d.ts` as `resolveHappierItemBehavior`.

```ts
function resolveHappierItemBehavior(input: HappierItemBehaviorInput): HappierItemBehavior;
```


### `./presentation` — `resolveHappierItemGroupConstraints` (value)

Declared by `dist/presentation/collection/semantics.d.ts` as `resolveHappierItemGroupConstraints`.

```ts
function resolveHappierItemGroupConstraints(input: Readonly<{
    role?: 'radiogroup';
    accessibilityLabel?: string;
    columns: number;
    virtualized: boolean;
}>): void;
```


### `./presentation` — `resolveHappierItemSemantics` (value)

Declared by `dist/presentation/collection/semantics.d.ts` as `resolveHappierItemSemantics`.

```ts
function resolveHappierItemSemantics(input: HappierItemSemanticInput): Readonly<{
    accessibilityState?: HappierItemSemanticState;
    tabIndex: -1 | 0;
}>;
```


### `./presentation` — `resolveHappierLayoutGap` (value)

Declared by `dist/presentation/layout/layoutSemantics.d.ts` as `resolveHappierLayoutGap`.

```ts
function resolveHappierLayoutGap(gap: HappierLayoutGap | undefined, spacing: HappierLayoutSpacing): number;
```


### `./presentation` — `resolveHappierListMultiSelectionKeyboardIntent` (value)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `resolveHappierListMultiSelectionKeyboardIntent`.

```ts
function resolveHappierListMultiSelectionKeyboardIntent(input: HappierListMultiSelectionKeyboardInput): HappierListMultiSelectionKeyboardIntent | null;
```


### `./presentation` — `resolveHappierListMultiSelectionPointerAction` (value)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `resolveHappierListMultiSelectionPointerAction`.

```ts
function resolveHappierListMultiSelectionPointerAction(input: HappierListMultiSelectionPointerInput): HappierListMultiSelectionPointerAction;
```


### `./presentation` — `resolveHappierListMultiSelectionRange` (value)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `resolveHappierListMultiSelectionRange`.

```ts
function resolveHappierListMultiSelectionRange(input: HappierListMultiSelectionRangeInput): HappierListMultiSelectionKey[];
```


### `./presentation` — `resolveHappierMenuContent` (value)

Declared by `dist/presentation/interaction/Menu.d.ts` as `resolveHappierMenuContent`.

```ts
function resolveHappierMenuContent<Item extends HappierMenuItemDescriptor>(input: Readonly<{
    items?: readonly Item[];
    groups?: readonly HappierMenuGroupDescriptor<Item>[];
}>): HappierMenuContent<Item>;
```


### `./presentation` — `resolveHappierMenuKeyAction` (value)

Declared by `dist/presentation/interaction/Menu.d.ts` as `resolveHappierMenuKeyAction`.

```ts
function resolveHappierMenuKeyAction(key: string): HappierMenuKeyAction;
```


### `./presentation` — `resolveHappierMenuRadioGroups` (value)

Declared by `dist/presentation/interaction/Menu.d.ts` as `resolveHappierMenuRadioGroups`.

```ts
function resolveHappierMenuRadioGroups(input: Readonly<{
    items: readonly HappierMenuItemDescriptor[];
    radioGroups: readonly HappierMenuRadioGroupDescriptor[];
}>): ReadonlyMap<string, HappierMenuRadioGroupDescriptor>;
```


### `./presentation` — `resolveHappierMenuSelection` (value)

Declared by `dist/presentation/interaction/Menu.d.ts` as `resolveHappierMenuSelection`.

```ts
function resolveHappierMenuSelection(input: Readonly<{
    items: readonly HappierMenuItemDescriptor[];
    selectedIndex: number;
    direction: -1 | 1;
    wrap: boolean;
}>): number;
```


### `./presentation` — `resolveHappierMenuTypeahead` (value)

Declared by `dist/presentation/interaction/Menu.d.ts` as `resolveHappierMenuTypeahead`.

```ts
function resolveHappierMenuTypeahead(input: Readonly<{
    items: readonly HappierMenuItemDescriptor[];
    selectedIndex: number;
    query: string;
}>): number;
```


### `./presentation` — `resolveHappierPointerPlatform` (value)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `resolveHappierPointerPlatform`.

```ts
function resolveHappierPointerPlatform(platformOs: string): HappierPointerPlatform;
```


### `./presentation` — `resolveHappierPopoverPlacement` (value)

Declared by `dist/presentation/interaction/Menu.d.ts` as `resolveHappierPopoverPlacement`.

```ts
function resolveHappierPopoverPlacement(input: Readonly<{
    placement: HappierPopoverPlacement;
    available: Readonly<Record<HappierResolvedPopoverPlacement, number>>;
    preferredMinAvailable?: number;
}>): HappierResolvedPopoverPlacement;
```


### `./presentation` — `resolveHappierProgressPercentage` (value)

Declared by `dist/presentation/content/Foundation.d.ts` as `resolveHappierProgressPercentage`.

```ts
function resolveHappierProgressPercentage(value: number | undefined, options?: Readonly<{
    indeterminate?: number;
    minimumVisible?: number;
}>): number;
```


### `./presentation` — `resolveHappierRovingSelection` (value)

Declared by `dist/presentation/collection/semantics.d.ts` as `resolveHappierRovingSelection`.

```ts
function resolveHappierRovingSelection(input: Readonly<{
    entries: readonly HappierRovingEntry[];
    currentIndex: number;
    key: string;
    rtl: boolean;
    listNavigationKeys?: boolean;
}>): number | null;
```


### `./presentation` — `resolveHappierTabKeySelection` (value)

Declared by `dist/presentation/navigation/Tabs.d.ts` as `resolveHappierTabKeySelection`.

```ts
function resolveHappierTabKeySelection<T extends object>(input: Readonly<{
    tabs: readonly T[];
    currentIndex: number;
    key: string;
    rtl: boolean;
}>): number | null;
```


### `./presentation` — `resolveHappierWebSpinnerPresentation` (value)

Declared by `dist/presentation/feedback/Spinner.d.ts` as `resolveHappierWebSpinnerPresentation`.

```ts
function resolveHappierWebSpinnerPresentation(input: HappierWebSpinnerPresentationInput): HappierWebSpinnerPresentation | null;
```


### `./presentation` — `scaleTextStyleMetrics` (value)

Declared by `dist/presentation/text/textStyleScale.d.ts` as `scaleTextStyleMetrics`.

```ts
function scaleTextStyleMetrics<T>(style: T, textScale: number, options?: ScaleTextStyleOptions): ScaledTextStyleMetrics<T>;
```


### `./presentation` — `toHappierListMultiSelectionSnapshot` (value)

Declared by `dist/presentation/collection/multiSelection.d.ts` as `toHappierListMultiSelectionSnapshot`.

```ts
function toHappierListMultiSelectionSnapshot(state: HappierListMultiSelectionState): HappierListMultiSelectionSnapshot;
```


### `./presentation` — `useHappierCodeBlockBehavior` (value)

Declared by `dist/presentation/content/CodeBlock.d.ts` as `useHappierCodeBlockBehavior`.

```ts
function useHappierCodeBlockBehavior(input: HappierCodeBlockBehaviorInput): {
    readonly language: string | undefined;
    readonly shouldRenderHeaderRow: boolean;
    readonly shouldOverlayCopyButton: boolean;
    readonly copied: boolean;
    readonly copy: () => Promise<boolean>;
};
```


### `./presentation` — `useHappierFormSubmission` (value)

Declared by `dist/presentation/form/Fields.d.ts` as `useHappierFormSubmission`.

```ts
function useHappierFormSubmission(busy?: boolean): Readonly<{
    pending: boolean;
    submit: (operation: () => unknown) => void;
}>;
```


### `./presentation` — `useHappierItemGroupItemBehavior` (value)

Declared by `dist/presentation/collection/ItemGroup.d.ts` as `useHappierItemGroupItemBehavior`.

```ts
function useHappierItemGroupItemBehavior(input: HappierItemGroupItemBehaviorInput): {
    readonly grouped: boolean;
    readonly onKeyDown: (key: string) => boolean;
    readonly selectableItemCount: number | undefined;
    readonly tabStopIndex: number | null | undefined;
    readonly targetRef: (target: HappierItemGroupRadioFocusable | null) => void;
};
```


### `./presentation` — `useHappierMenuInteraction` (value)

Declared by `dist/presentation/interaction/Menu.d.ts` as `useHappierMenuInteraction`.

```ts
function useHappierMenuInteraction<Item extends HappierMenuInteractionItem>(input: HappierMenuInteractionInput<Item>): {
    readonly selectedIndex: number;
    readonly setSelectedIndex: (index: number) => void;
    readonly handleKeyPress: (key: string, onActivate: (item: Item) => void, activeIndex?: number) => boolean;
};
```


### `./presentation` — `useHappierTabPanelActivity` (value)

Declared by `dist/presentation/navigation/Tabs.d.ts` as `useHappierTabPanelActivity`.

```ts
function useHappierTabPanelActivity(): HappierTabPanelActivity;
```


### `./presentation` — `useHappierTextPresentation` (value)

Declared by `dist/presentation/text/Text.d.ts` as `useHappierTextPresentation`.

```ts
function useHappierTextPresentation({ selectable, textScale, }: HappierTextPresentationInput): HappierTextPresentation;
```


### `./presentation` — `writeHappierActionInputPath` (value)

Declared by `dist/presentation/form/actionInputFields.d.ts` as `writeHappierActionInputPath`.

```ts
function writeHappierActionInputPath(input: InputRecord, path: string, value: unknown): Record<string, unknown>;
```


### `./testing` — `PluginUiRnwSemanticSurfaceAdapterOptions` (type)

Declared by `dist/testing/rnwSemanticAdapter.d.ts` as `PluginUiRnwSemanticSurfaceAdapterOptions`.

```ts
type PluginUiRnwSemanticSurfaceAdapterOptions = Readonly<{
    physicalFocus?: (target: HappierFocusable) => boolean;
    ephemeralSharedScope?: PluginUiEphemeralSharedScope;
    targetedSurfaces?: Readonly<{
        readCurrentMounts(): unknown;
        readContributorManifest(pluginId: string): unknown;
    }>;
}>;
```


### `./testing` — `createPluginUiRnwSemanticSurfaceAdapter` (value)

Declared by `dist/testing/rnwSemanticAdapter.d.ts` as `createPluginUiRnwSemanticSurfaceAdapter`.

```ts
function createPluginUiRnwSemanticSurfaceAdapter(options?: PluginUiRnwSemanticSurfaceAdapterOptions): PluginUiSemanticSurfaceAdapter<RenderSurface>;
```


## Reachable package-owned declarations

### `dist/components/Action.d.ts` — `ActionChromeProps`

Reached from a published signature; not itself a published export.

```ts
type ActionChromeProps = Readonly<{
    title?: string;
    titleKey?: string;
    icon?: ReactNode;
    variant?: ButtonVariant;
    disabled?: boolean;
    accessibilityLabel?: string;
    accessibilityLabelKey?: string;
    testID?: string;
}>;
```


### `dist/components/Action.d.ts` — `ActionCopy`

Reached from a published signature; not itself a published export.

```ts
function ActionCopy({ value, ...chrome }: ActionCopyProps): ReactElement;
```


### `dist/components/Action.d.ts` — `ActionExecute`

Reached from a published signature; not itself a published export.

```ts
function ActionExecute<TAction extends PluginUiActionReference>({ action, input, onSettled, ...chrome }: ActionExecuteProps<TAction>): ReactElement;
```


### `dist/components/Action.d.ts` — `ActionGroupProps`

Reached from a published signature; not itself a published export.

```ts
type ActionGroupProps = Readonly<{
    title?: string;
    titleKey?: string;
    testID?: string;
    children?: ReactNode;
}>;
```


### `dist/components/Action.d.ts` — `ActionOpenExternal`

Reached from a published signature; not itself a published export.

```ts
function ActionOpenExternal({ url, ...chrome }: ActionOpenExternalProps): ReactElement;
```


### `dist/components/Action.d.ts` — `ActionOpenSurface`

Reached from a published signature; not itself a published export.

```ts
function ActionOpenSurface({ view, input, ...chrome }: ActionOpenSurfaceProps): ReactElement;
```


### `dist/components/Action.d.ts` — `ActionPanelRoot`

Reached from a published signature; not itself a published export.

```ts
function ActionPanelRoot({ title, titleKey, testID, children }: ActionGroupProps): ReactElement;
```


### `dist/components/Action.d.ts` — `ActionPanelSection`

Reached from a published signature; not itself a published export.

```ts
function ActionPanelSection({ title, titleKey, testID, children }: ActionGroupProps): ReactElement;
```


### `dist/components/Action.d.ts` — `ActionRefresh`

Reached from a published signature; not itself a published export.

```ts
function ActionRefresh({ onRefresh, ...chrome }: ActionRefreshProps): ReactElement;
```


### `dist/components/Button.d.ts` — `ButtonCommonProps`

Reached from a published signature; not itself a published export.

```ts
type ButtonCommonProps = Readonly<{
    title?: string;
    titleKey?: string;
    accessibilityLabelKey?: string;
    variant?: ButtonVariant;
    disabled?: boolean;
    busy?: boolean;
    icon?: ReactNode;
    focusTarget?: PluginUiFocusTarget;
    testID?: string;
    onPress: () => unknown;
    children?: ReactNode;
}>;
```


### `dist/components/Button.d.ts` — `ButtonWithExplicitAccessibleNameProps`

Reached from a published signature; not itself a published export.

```ts
type ButtonWithExplicitAccessibleNameProps = ButtonCommonProps & Readonly<{
    accessibilityLabel: string;
}>;
```


### `dist/components/Button.d.ts` — `ButtonWithVisibleTitleProps`

Reached from a published signature; not itself a published export.

```ts
type ButtonWithVisibleTitleProps = ButtonCommonProps & Readonly<{
    title: string;
    accessibilityLabel?: string;
}>;
```


### `dist/components/Form.d.ts` — `FormActions`

Reached from a published signature; not itself a published export.

```ts
function FormActions({ children }: FormActionsProps): ReactElement;
```


### `dist/components/Form.d.ts` — `FormOption`

Reached from a published signature; not itself a published export.

```ts
type FormOption = Readonly<{
    value: FormOptionValue;
    label: string;
    description?: string;
    disabled?: boolean;
    accessibilityLabel?: string;
    testID?: string;
}>;
```


### `dist/components/Form.d.ts` — `FormOptionValue`

Reached from a published signature; not itself a published export.

```ts
type FormOptionValue = ActionInputOptionValue;
```


### `dist/components/Form.d.ts` — `FormRoot`

Reached from a published signature; not itself a published export.

```ts
function FormRoot(props: FormProps): ReactElement;
```


### `dist/components/Foundation.d.ts` — `AuthorText`

Reached from a published signature; not itself a published export.

```ts
type AuthorText = Readonly<{
    value?: string;
    valueKey?: string;
    fallback?: string;
}>;
```


### `dist/components/List.d.ts` — `FlatVirtualizedListProps`

Reached from a published signature; not itself a published export.

```ts
type FlatVirtualizedListProps<Item> = (NonSelectableVirtualizedListProps<Item> | SelectableVirtualizedListProps<Item>) & Readonly<{
    items: readonly Item[];
    sections?: never;
}>;
```


### `dist/components/List.d.ts` — `ItemSecondaryAction`

Reached from a published signature; not itself a published export.

```ts
type ItemSecondaryAction = Readonly<{
    id: string;
    label: string;
    disabled?: boolean;
    icon?: ReactNode;
}>;
```


### `dist/components/List.d.ts` — `ItemSecondaryActionsProps`

Reached from a published signature; not itself a published export.

```ts
type ItemSecondaryActionsProps = Readonly<{
    secondaryActions: readonly ItemSecondaryAction[];
    secondaryActionAccessibilityLabel?: string;
    onSecondaryAction: (id: string) => void;
}> | Readonly<{
    secondaryActions?: undefined;
    secondaryActionAccessibilityLabel?: never;
    onSecondaryAction?: undefined;
}>;
```


### `dist/components/List.d.ts` — `ListAccessibleNameProps`

Reached from a published signature; not itself a published export.

```ts
type ListAccessibleNameProps = Readonly<{
    accessibilityLabel: string;
    accessibilityLabelKey?: string;
}> | Readonly<{
    accessibilityLabel?: string;
    accessibilityLabelKey: string;
}>;
```


### `dist/components/List.d.ts` — `ListBaseProps`

Reached from a published signature; not itself a published export.

```ts
type ListBaseProps = Readonly<{
    accessibilityLabel?: string;
    accessibilityLabelKey?: string;
    testID?: string;
    style?: HappierStyleProp;
    density?: 'compact' | 'regular';
}>;
```


### `dist/components/List.d.ts` — `ListItem`

Reached from a published signature; not itself a published export.

```ts
function ListItem(props: ListItemProps): ReactElement;
```


### `dist/components/List.d.ts` — `ListRoot`

Reached from a published signature; not itself a published export.

```ts
function ListRoot<Item>(props: ListProps<Item>): ReactElement;
```


### `dist/components/List.d.ts` — `ListSearchBaseProps`

Reached from a published signature; not itself a published export.

```ts
type ListSearchBaseProps<Item> = Readonly<{
    label: string;
    placeholder?: string;
    testID?: string;
    filter: (item: Item, query: string) => boolean;
    onComposingValueChange?: (value: string | null) => void;
}>;
```


### `dist/components/List.d.ts` — `ListSection`

Reached from a published signature; not itself a published export.

```ts
function ListSection(props: ListSectionProps): ReactElement;
```


### `dist/components/List.d.ts` — `ListSelectionBaseProps`

Reached from a published signature; not itself a published export.

```ts
type ListSelectionBaseProps<Item> = Readonly<{
    isItemActivatable?: (item: Item, index: number) => boolean;
    isItemDisabled?: (item: Item, index: number) => boolean;
    onFocusedKeyChange?: (key: string) => void;
    focusRequest?: Readonly<{
        key: string;
    }>;
    multiple?: ListMultiSelectionCapabilityProps<Item>;
}>;
```


### `dist/components/List.d.ts` — `NonSelectableVirtualizedListProps`

Reached from a published signature; not itself a published export.

```ts
type NonSelectableVirtualizedListProps<Item> = VirtualizedListSharedProps<Item> & Readonly<{
    selection?: undefined;
}>;
```


### `dist/components/List.d.ts` — `SectionedVirtualizedListProps`

Reached from a published signature; not itself a published export.

```ts
type SectionedVirtualizedListProps<Item> = (NonSelectableVirtualizedListProps<Item> | SelectableVirtualizedListProps<Item>) & Readonly<{
    items?: never;
    sections: readonly ListSectionData<Item>[];
}>;
```


### `dist/components/List.d.ts` — `SelectableVirtualizedListProps`

Reached from a published signature; not itself a published export.

```ts
type SelectableVirtualizedListProps<Item> = VirtualizedListSharedProps<Item> & ListAccessibleNameProps & Readonly<{
    selection: ListSelectionProps<Item>;
    accessibilityPattern?: ListAccessibilityPattern;
}>;
```


### `dist/components/List.d.ts` — `StaticListProps`

Reached from a published signature; not itself a published export.

```ts
type StaticListProps = Readonly<{
    items?: never;
    sections?: never;
    keyForItem?: never;
    renderItem?: never;
    header?: never;
    search?: never;
    selection?: never;
    empty?: never;
    footer?: never;
    contentContainerStyle?: never;
    children?: ReactNode;
}>;
```


### `dist/components/List.d.ts` — `VirtualizedListProps`

Reached from a published signature; not itself a published export.

```ts
type VirtualizedListProps<Item> = FlatVirtualizedListProps<Item> | SectionedVirtualizedListProps<Item>;
```


### `dist/components/List.d.ts` — `VirtualizedListSharedProps`

Reached from a published signature; not itself a published export.

```ts
type VirtualizedListSharedProps<Item> = Readonly<{
    keyForItem: (item: Item, index: number) => string;
    renderItem: (item: Item, index: number, sectionKey: string | null) => ReactNode;
    header?: ReactNode | ((context: ListHeaderContext<Item>) => ReactNode);
    search?: ListSearchProps<Item>;
    empty?: ReactNode;
    footer?: ReactNode;
    contentContainerStyle?: HappierStyleProp;
    preserveVisibleContentPositionOnPrepend?: boolean;
    preserveVisibleContentPositionOnInsert?: Readonly<{
        anchorKey: string;
        revision: string | number;
    }>;
    children?: never;
}>;
```


### `dist/components/Overlay.d.ts` — `MenuContentProps`

Reached from a published signature; not itself a published export.

```ts
type MenuContentProps = Readonly<{
    items: readonly MenuItem[];
    groups?: readonly MenuGroup[];
}> | Readonly<{
    items?: never;
    groups: readonly MenuGroup[];
}>;
```


### `dist/components/Overlay.d.ts` — `MenuItemBase`

Reached from a published signature; not itself a published export.

```ts
type MenuItemBase = Readonly<{
    id: string;
    label: string;
    disabled?: boolean;
}>;
```


### `dist/components/State.d.ts` — `StateCopyProps`

Reached from a published signature; not itself a published export.

```ts
type StateCopyProps = Readonly<{
    title?: string;
    titleKey?: string;
    description?: string;
    descriptionKey?: string;
    action?: ReactNode;
    testID?: string;
}>;
```


### `dist/components/Tabs.d.ts` — `TabsItem`

Reached from a published signature; not itself a published export.

```ts
function TabsItem(_props: TabsItemProps): null;
```


### `dist/components/Tabs.d.ts` — `TabsRoot`

Reached from a published signature; not itself a published export.

```ts
function TabsRoot(props: TabsProps): ReactElement;
```


### `dist/components/TargetedSurface.d.ts` — `TargetedSurfaceInput`

Reached from a published signature; not itself a published export.

```ts
type TargetedSurfaceInput<TSurface extends PluginUiTargetedContributionSurfaceV1> = TSurface extends ContributionSurfaceHandle<infer TInput, infer _TPointId> ? TInput : JsonValue;
```


### `dist/hostApi/context.d.ts` — `PluginHostApiProviderInternalProps`

Reached from a published signature; not itself a published export.

```ts
type PluginHostApiProviderInternalProps = PluginHostApiProviderProps & Readonly<{
    accountLifetime?: PluginUiResourceAccountLifetime | null;
    resourceStoreGeneration?: unknown;
    mountedPluginId?: string;
    composerRef?: ComposerRefV1 | null;
    surfaceActivity?: Readonly<{
        active: boolean;
    }>;
    ephemeralSharedScope?: PluginUiEphemeralSharedScope | null;
}>;
```


### `dist/presentation/collection/ItemGroup.d.ts` — `HappierItemGroupRadioContext`

Reached from a published signature; not itself a published export.

```ts
type HappierItemGroupRadioContext = Readonly<{
    tabStopIndex: number | null;
    register(index: number, target: HappierItemGroupRadioFocusable | null): () => void;
    move(index: number, key: string): boolean;
}>;
```


### `dist/presentation/collection/semantics.d.ts` — `HappierRovingCollectionItem`

Reached from a published signature; not itself a published export.

```ts
type HappierRovingCollectionItem = Readonly<{
    isTabStop: boolean;
    onKeyDown: (key: string, event: unknown) => boolean;
    register: (target: HappierFocusable | null) => void;
}>;
```


### `dist/presentation/form/actionInputFields.d.ts` — `HappierActionInputField`

Reached from a published signature; not itself a published export.

```ts
type HappierActionInputField = Readonly<{
    widget: 'boolean' | 'select' | 'multiselect' | 'json' | 'text_list' | 'secret' | 'textarea' | 'url' | 'number' | 'integer' | string;
    listSeparator?: 'comma' | 'newline';
}>;
```


### `dist/presentation/form/actionInputFields.d.ts` — `InputRecord`

Reached from a published signature; not itself a published export.

```ts
type InputRecord = Readonly<Record<string, unknown>>;
```


### `dist/presentation/interaction/Menu.d.ts` — `HappierMenuInteractionItem`

Reached from a published signature; not itself a published export.

```ts
type HappierMenuInteractionItem = Readonly<{
    id: string;
    disabled?: boolean;
}>;
```


### `dist/presentation/portableTypes.d.ts` — `HappierAccessibilityLiveRegion`

Reached from a published signature; not itself a published export.

```ts
type HappierAccessibilityLiveRegion = 'none' | 'polite' | 'assertive';
```


### `dist/presentation/portableTypes.d.ts` — `HappierActivityIndicatorHostProps`

Reached from a published signature; not itself a published export.

```ts
type HappierActivityIndicatorHostProps = Readonly<{
    'aria-hidden'?: boolean;
    accessibilityElementsHidden?: boolean;
    accessibilityLabel?: string;
    accessibilityRole?: 'progressbar';
    animating?: boolean;
    color?: string;
    hidesWhenStopped?: boolean;
    importantForAccessibility?: 'auto' | 'yes' | 'no' | 'no-hide-descendants';
    size?: 'small' | 'large' | number;
    style?: HappierStyleProp;
    testID?: string;
}>;
```


### `dist/presentation/portableTypes.d.ts` — `HappierAlignment`

Reached from a published signature; not itself a published export.

```ts
type HappierAlignment = 'baseline' | 'center' | 'flex-end' | 'flex-start' | 'stretch';
```


### `dist/presentation/portableTypes.d.ts` — `HappierDimension`

Reached from a published signature; not itself a published export.

```ts
type HappierDimension = number | `${number}%` | 'auto';
```


### `dist/presentation/portableTypes.d.ts` — `HappierFocusable`

Reached from a published signature; not itself a published export.

```ts
type HappierFocusable = Readonly<{
    focus: () => void;
}>;
```


### `dist/presentation/portableTypes.d.ts` — `HappierFontWeight`

Reached from a published signature; not itself a published export.

```ts
type HappierFontWeight = 'normal' | 'bold' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900' | 'ultralight' | 'thin' | 'light' | 'medium' | 'regular' | 'semibold' | 'condensedBold' | 'condensed' | 'heavy' | 'black' | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
```


### `dist/presentation/portableTypes.d.ts` — `HappierGestureResponderEvent`

Reached from a published signature; not itself a published export.

```ts
type HappierGestureResponderEvent = Readonly<{
    nativeEvent: unknown;
    preventDefault?: () => void;
    stopPropagation?: () => void;
}>;
```


### `dist/presentation/portableTypes.d.ts` — `HappierJustification`

Reached from a published signature; not itself a published export.

```ts
type HappierJustification = 'center' | 'flex-end' | 'flex-start' | 'space-around' | 'space-between' | 'space-evenly';
```


### `dist/presentation/portableTypes.d.ts` — `HappierKeyboardShouldPersistTaps`

Reached from a published signature; not itself a published export.

```ts
type HappierKeyboardShouldPersistTaps = boolean | 'always' | 'never' | 'handled';
```


### `dist/presentation/portableTypes.d.ts` — `HappierPortableStyle`

Reached from a published signature; not itself a published export.

```ts
type HappierPortableStyle = Readonly<{
    alignContent?: 'flex-start' | 'flex-end' | 'center' | 'stretch' | 'space-between' | 'space-around' | 'space-evenly';
    alignItems?: HappierAlignment;
    alignSelf?: 'auto' | HappierAlignment;
    aspectRatio?: number | string;
    backgroundColor?: string;
    borderBottomColor?: string;
    borderBottomLeftRadius?: number | string;
    borderBottomRightRadius?: number | string;
    borderBottomWidth?: number;
    borderColor?: string;
    borderLeftColor?: string;
    borderLeftWidth?: number;
    borderRadius?: number | string;
    borderRightColor?: string;
    borderRightWidth?: number;
    borderStyle?: 'solid' | 'dotted' | 'dashed';
    borderTopColor?: string;
    borderTopLeftRadius?: number | string;
    borderTopRightRadius?: number | string;
    borderTopWidth?: number;
    borderWidth?: number;
    bottom?: HappierDimension;
    color?: string;
    columnGap?: number | string;
    cursor?: 'auto' | 'pointer';
    direction?: 'inherit' | 'ltr' | 'rtl';
    display?: 'none' | 'flex' | 'contents';
    elevation?: number;
    flex?: number;
    flexBasis?: HappierDimension;
    flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse';
    flexGrow?: number;
    flexShrink?: number;
    flexWrap?: 'wrap' | 'nowrap' | 'wrap-reverse';
    fontFamily?: string;
    fontSize?: number;
    fontStyle?: 'normal' | 'italic';
    fontWeight?: HappierFontWeight;
    gap?: number | string;
    height?: HappierDimension;
    includeFontPadding?: boolean;
    justifyContent?: HappierJustification;
    left?: HappierDimension;
    letterSpacing?: number;
    lineHeight?: number;
    margin?: HappierDimension;
    marginBottom?: HappierDimension;
    marginHorizontal?: HappierDimension;
    marginLeft?: HappierDimension;
    marginRight?: HappierDimension;
    marginTop?: HappierDimension;
    marginVertical?: HappierDimension;
    maxHeight?: HappierDimension;
    maxWidth?: HappierDimension;
    minHeight?: HappierDimension;
    minWidth?: HappierDimension;
    opacity?: number;
    overflow?: 'visible' | 'hidden' | 'scroll';
    padding?: HappierDimension;
    paddingBottom?: HappierDimension;
    paddingHorizontal?: HappierDimension;
    paddingLeft?: HappierDimension;
    paddingRight?: HappierDimension;
    paddingTop?: HappierDimension;
    paddingVertical?: HappierDimension;
    pointerEvents?: 'box-none' | 'none' | 'box-only' | 'auto';
    position?: 'absolute' | 'relative' | 'static';
    right?: HappierDimension;
    rowGap?: number | string;
    shadowColor?: string;
    shadowOffset?: Readonly<{
        width: number;
        height: number;
    }>;
    shadowOpacity?: number;
    shadowRadius?: number;
    textAlign?: 'auto' | 'left' | 'right' | 'center' | 'justify';
    textAlignVertical?: 'auto' | 'top' | 'bottom' | 'center';
    textDecorationColor?: string;
    textDecorationLine?: 'none' | 'underline' | 'line-through' | 'underline line-through';
    textDecorationStyle?: 'solid' | 'double' | 'dotted' | 'dashed';
    textShadowColor?: string;
    textShadowOffset?: Readonly<{
        width: number;
        height: number;
    }>;
    textShadowRadius?: number;
    textTransform?: 'none' | 'capitalize' | 'uppercase' | 'lowercase';
    top?: HappierDimension;
    userSelect?: 'auto' | 'none' | 'text' | 'contain' | 'all';
    verticalAlign?: 'auto' | 'top' | 'bottom' | 'middle';
    width?: HappierDimension;
    writingDirection?: 'auto' | 'ltr' | 'rtl';
    zIndex?: number;
}>;
```


### `dist/presentation/portableTypes.d.ts` — `HappierScrollEvent`

Reached from a published signature; not itself a published export.

```ts
type HappierScrollEvent = Readonly<{
    nativeEvent: unknown;
}>;
```


### `dist/presentation/portableTypes.d.ts` — `HappierStyleProp`

Reached from a published signature; not itself a published export.

```ts
type HappierStyleProp = HappierPortableStyle | false | null | undefined | HappierStyleProp[];
```


### `dist/presentation/portableTypes.d.ts` — `HappierTextHostProps`

Reached from a published signature; not itself a published export.

```ts
type HappierTextHostProps = Readonly<{
    children?: ReactNode;
    style?: HappierStyleProp;
    accessible?: boolean;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    accessibilityLiveRegion?: HappierAccessibilityLiveRegion;
    accessibilityRole?: 'alert' | 'header' | 'link' | 'none' | 'text';
    allowFontScaling?: boolean;
    ellipsizeMode?: 'clip' | 'head' | 'middle' | 'tail';
    maxFontSizeMultiplier?: number | null;
    nativeID?: string;
    numberOfLines?: number;
    onLayout?: (event: HappierLayoutChangeEvent) => void;
    onLongPress?: (event?: HappierGestureResponderEvent) => void;
    onPress?: (event?: HappierGestureResponderEvent) => void;
    selectable?: boolean;
    suppressHighlighting?: boolean;
    testID?: string;
}>;
```


### `dist/presentation/text/textStyleScale.d.ts` — `IsExactly`

Reached from a published signature; not itself a published export.

```ts
type IsExactly<Left, Right> = [
    Left
] extends [
    Right
] ? [
    Right
] extends [
    Left
] ? true : false : false;
```


### `dist/presentation/text/textStyleScale.d.ts` — `ScaleTextMetricValue`

Reached from a published signature; not itself a published export.

```ts
type ScaleTextMetricValue<Value> = Value extends number ? number : Value;
```


### `dist/presentation/text/textStyleScale.d.ts` — `ScaledTextMetricKey`

Reached from a published signature; not itself a published export.

```ts
type ScaledTextMetricKey = 'fontSize' | 'lineHeight' | 'letterSpacing';
```


### `dist/presentation/text/textStyleScale.d.ts` — `ScaledTextStyleArray`

Reached from a published signature; not itself a published export.

```ts
type ScaledTextStyleArray<T extends readonly unknown[]> = number extends T['length'] ? T extends unknown[] ? ScaledTextStyleMetrics<T[number]>[] : readonly ScaledTextStyleMetrics<T[number]>[] : {
    [Index in keyof T]: ScaledTextStyleMetrics<T[Index]>;
};
```


## Referenced declarations owned by other packages

- `@happier-dev/plugin-sdk#AccountKvService`
- `@happier-dev/plugin-sdk#ActionFormFieldHint`
- `@happier-dev/plugin-sdk#ActionFormHints`
- `@happier-dev/plugin-sdk#ActionInputOptionValue`
- `@happier-dev/plugin-sdk#ComposerDecorationSetV1`
- `@happier-dev/plugin-sdk#ContributionSurfaceHandle`
- `@happier-dev/plugin-sdk#Disposable`
- `@happier-dev/plugin-sdk#PluginAccountCollectionDefinition`
- `@happier-dev/plugin-sdk#PluginAccountCollectionForDefinition`
- `@happier-dev/plugin-sdk#PluginError`
- `@happier-dev/plugin-sdk#PluginReference`
- `@happier-dev/plugin-sdk#PluginUiActionExecutionOptions`
- `@happier-dev/plugin-sdk#PluginUiActionInputFor`
- `@happier-dev/plugin-sdk#PluginUiActionReference`
- `@happier-dev/plugin-sdk#PluginUiActionResultFor`
- `@happier-dev/plugin-sdk#PluginUiHostApi`
- `@happier-dev/plugin-sdk#PluginUiIconTokenV1`
- `@happier-dev/plugin-sdk#PluginUiPlatform`
- `@happier-dev/plugin-sdk#PluginUiSemanticSurfaceAdapter`
- `@happier-dev/plugin-sdk#PluginUiTargetedContributionSurfaceV1`
- `@happier-dev/plugin-sdk#PluginUiThemeV1`
- `@happier-dev/plugin-sdk#ProtocolJsonValue`
- `@happier-dev/plugin-sdk#RenderContext`
- `@happier-dev/plugin-sdk#RenderSurface`
- `@happier-dev/plugin-sdk#ResourceContent`
- `@happier-dev/plugin-sdk#SurfaceContext`
- `@happier-dev/protocol#PluginCollectionUiQueryErrorV1`
- `@happier-dev/protocol#PluginCollectionUiQueryRequestV1`
- `@happier-dev/protocol#PluginCollectionUiQueryResultV1`
- `@happier-dev/protocol#ReviewCommentSnapshotV1`
- `@happier-dev/protocol#ReviewCommentV1`
- `@types/node#AbortSignal`
- `@types/react#ComponentType`
- `@types/react#Context`
- `@types/react#Element`
- `@types/react#FunctionComponentElement`
- `@types/react#NamedExoticComponent`
- `@types/react#ReactElement`
- `@types/react#ReactNode`
- `@types/react#RefAttributes`
- `@types/react#RefObject`
