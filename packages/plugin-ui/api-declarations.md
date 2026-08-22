# Plugin UI public declaration report

> Generated from package source. Do not hand-edit.
> Records the normalized declaration behind every published export, plus the
> declarations those signatures reach, so no signature this package ships can
> change without a reviewable diff. Implementation bodies, initializers, private
> class members and comments are omitted; inferred value and return types are
> materialized.
> Every published export is recorded in full, including one a `bundledDependencies`
> package declares, because this tarball vendors it and nothing else will publish it.
> Reachability then stops at that boundary: a declaration reached only through a
> signature, and declared by another package — vendored or resolved separately — is
> recorded as a named edge, because that package owns its own internals and
> `package.json` already pins the version that supplies them.
> Whether a difference is breaking or additive stays a publishing decision.

## Published exports

### `.` — `Action` (value)

Declared by `src/components/Action.tsx` as `Action`.

```ts
const Action: { readonly Execute: <TAction extends PluginUiActionReference>({ action, input, onSettled, ...chrome }: ActionExecuteProps<TAction>) => ReactElement; readonly Copy: ({ value, ...chrome }: ActionCopyProps) => ReactElement; readonly OpenExternal: ({ url, ...chrome }: ActionOpenExternalProps) => ReactElement; readonly OpenSurface: ({ view, input, ...chrome }: ActionOpenSurfaceProps) => ReactElement; readonly Refresh: ({ onRefresh, ...chrome }: ActionRefreshProps) => ReactElement; };
```


### `.` — `ActionCopyProps` (type)

Declared by `src/components/Action.tsx` as `ActionCopyProps`.

```ts
type ActionCopyProps = ActionChromeProps & Readonly<{
    value: string;
}>;
```


### `.` — `ActionExecuteProps` (type)

Declared by `src/components/Action.tsx` as `ActionExecuteProps`.

```ts
type ActionExecuteProps<TAction extends PluginUiActionReference = PluginUiActionReference> = ActionChromeProps & Readonly<{
    action: TAction;
    input?: NoInfer<PluginUiActionInputFor<NoInfer<TAction>>>;
    onSettled?: (execution: PluginActionExecution<PluginUiActionResultFor<NoInfer<TAction>>>) => void;
}>;
```


### `.` — `ActionOpenExternalProps` (type)

Declared by `src/components/Action.tsx` as `ActionOpenExternalProps`.

```ts
type ActionOpenExternalProps = ActionChromeProps & Readonly<{
    url: string;
}>;
```


### `.` — `ActionOpenSurfaceProps` (type)

Declared by `src/components/Action.tsx` as `ActionOpenSurfaceProps`.

```ts
type ActionOpenSurfaceProps = ActionChromeProps & Readonly<{
    view: PluginReference;
    input?: JsonValue;
}>;
```


### `.` — `ActionPanel` (value)

Declared by `src/components/Action.tsx` as `ActionPanel`.

```ts
const ActionPanel: (({ title, titleKey, testID, children }: ActionGroupProps) => ReactElement) & { Section: ({ title, titleKey, testID, children }: ActionGroupProps) => ReactElement; };
```


### `.` — `ActionPanelProps` (type)

Declared by `src/components/Action.tsx` as `ActionPanelProps`.

```ts
type ActionPanelProps = ActionGroupProps;
```


### `.` — `ActionPanelSectionProps` (type)

Declared by `src/components/Action.tsx` as `ActionPanelSectionProps`.

```ts
type ActionPanelSectionProps = ActionGroupProps;
```


### `.` — `ActionRefreshProps` (type)

Declared by `src/components/Action.tsx` as `ActionRefreshProps`.

```ts
type ActionRefreshProps = ActionChromeProps & Readonly<{
    onRefresh: () => unknown;
}>;
```


### `.` — `Badge` (value)

Declared by `src/components/Foundation.tsx` as `Badge`.

```ts
function Badge({ tone = 'neutral', testID, children, ...text }: BadgeProps): ReactElement;
```


### `.` — `BadgeProps` (type)

Declared by `src/components/Foundation.tsx` as `BadgeProps`.

```ts
type BadgeProps = AuthorText & Readonly<{
    tone?: HappierTone;
    testID?: string;
    children?: ReactNode;
}>;
```


### `.` — `Banner` (value)

Declared by `src/components/Foundation.tsx` as `Banner`.

```ts
function Banner({ tone = 'info', title, titleKey, description, descriptionKey, ...props }: BannerProps): ReactElement;
```


### `.` — `BannerProps` (type)

Declared by `src/components/Foundation.tsx` as `BannerProps`.

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

Declared by `src/components/Image.tsx` as `BrandMark`.

```ts
function BrandMark({ pluginId, size, showName = false, externallyLabelled = false, testID }: BrandMarkProps): ReactElement;
```


### `.` — `BrandMarkProps` (type)

Declared by `src/components/Image.tsx` as `BrandMarkProps`.

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

Declared by `src/components/Button.tsx` as `Button`.

```ts
function Button({ title, titleKey, accessibilityLabelKey, variant = 'primary', disabled, busy, icon, accessibilityLabel, focusTarget, testID, onPress, children, }: ButtonProps): ReactElement;
```


### `.` — `ButtonProps` (type)

Declared by `src/components/Button.tsx` as `ButtonProps`.

```ts
type ButtonProps = ButtonWithVisibleTitleProps | ButtonWithExplicitAccessibleNameProps;
```


### `.` — `ButtonVariant` (type)

Declared by `src/components/Button.tsx` as `ButtonVariant`.

```ts
type ButtonVariant = 'primary' | 'secondary' | 'plain';
```


### `.` — `Card` (value)

Declared by `src/components/Surface.tsx` as `Card`.

```ts
function Card({ padding = 'medium', ...props }: CardProps): ReactElement;
```


### `.` — `CardProps` (type)

Declared by `src/components/Surface.tsx` as `CardProps`.

```ts
type CardProps = SurfaceProps;
```


### `.` — `CodeBlock` (value)

Declared by `src/components/Content.tsx` as `CodeBlock`.

```ts
function CodeBlock({ code, language, selectable = true, copyLabel, copiedLabel, testID, }: CodeBlockProps): ReactElement;
```


### `.` — `CodeBlockProps` (type)

Declared by `src/components/Content.tsx` as `CodeBlockProps`.

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

Declared by `src/composer/types.ts` as `ComposerContentHandleV1`.

```ts
type ComposerContentHandleV1 = Awaited<ReturnType<PluginUiHostApi['pickComposerMedia']>>;
```


### `.` — `ComposerContentInspectRequestV1` (type)

Declared by `src/composer/types.ts` as `ComposerContentInspectRequestV1`.

```ts
type ComposerContentInspectRequestV1 = Parameters<PluginUiHostApi['inspectComposerContent']>[1];
```


### `.` — `ComposerContentInspectResultV1` (type)

Declared by `src/composer/types.ts` as `ComposerContentInspectResultV1`.

```ts
type ComposerContentInspectResultV1 = Awaited<ReturnType<PluginUiHostApi['inspectComposerContent']>>;
```


### `.` — `ComposerContentPickMediaRequestV1` (type)

Declared by `src/composer/types.ts` as `ComposerContentPickMediaRequestV1`.

```ts
type ComposerContentPickMediaRequestV1 = Parameters<PluginUiHostApi['pickComposerMedia']>[1];
```


### `.` — `ComposerContentService` (type)

Declared by `src/composer/service.ts` as `ComposerContentService`.

```ts
interface ComposerContentService {
    pickMedia(request: ComposerContentPickMediaRequestV1, options?: ComposerRequestOptions): Promise<ComposerContentHandleV1>;
    inspect(handle: ComposerContentHandleV1, request: ComposerContentInspectRequestV1, options?: ComposerRequestOptions): Promise<ComposerContentInspectResultV1>;
    release(handle: ComposerContentHandleV1, options?: ComposerRequestOptions): Promise<void>;
}
```


### `.` — `ComposerDecorationResultV1` (type)

Declared by `src/composer/types.ts` as `ComposerDecorationResultV1`.

```ts
type ComposerDecorationResultV1 = Awaited<ReturnType<PluginUiHostApi['setComposerDecorations']>>;
```


### `.` — `ComposerDecorationSetV1` (type)

Declared by `src/composer/types.ts` as `ComposerDecorationSetV1`.

```ts
type ComposerDecorationSetV1 = SdkComposerDecorationSetV1;
```


### `.` — `ComposerFocusResultV1` (type)

Declared by `src/composer/types.ts` as `ComposerFocusResultV1`.

```ts
type ComposerFocusResultV1 = Awaited<ReturnType<PluginUiHostApi['focusComposer']>>;
```


### `.` — `ComposerHandle` (type)

Declared by `src/composer/service.ts` as `ComposerHandle`.

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

Declared by `src/composer/types.ts` as `ComposerInputLockRequestV1`.

```ts
type ComposerInputLockRequestV1 = Parameters<PluginUiHostApi['acquireComposerInputLock']>[1];
```


### `.` — `ComposerObserverV1` (type)

Declared by `src/composer/types.ts` as `ComposerObserverV1`.

```ts
type ComposerObserverV1 = Parameters<PluginUiHostApi['watchComposer']>[1];
```


### `.` — `ComposerReadResultV1` (type)

Declared by `src/composer/types.ts` as `ComposerReadResultV1`.

```ts
type ComposerReadResultV1 = Awaited<ReturnType<PluginUiHostApi['readComposer']>>;
```


### `.` — `ComposerRefV1` (type)

Declared by `src/composer/types.ts` as `ComposerRefV1`.

```ts
type ComposerRefV1 = Parameters<PluginUiHostApi['readComposer']>[0];
```


### `.` — `ComposerRequestOptions` (type)

Declared by `src/composer/types.ts` as `ComposerRequestOptions`.

```ts
type ComposerRequestOptions = Parameters<PluginUiHostApi['readComposer']>[1];
```


### `.` — `ComposerSnapshotV1` (type)

Declared by `src/composer/types.ts` as `ComposerSnapshotV1`.

```ts
type ComposerSnapshotV1 = Extract<ComposerReadResultV1, Readonly<{
    status: 'ready';
}>>['snapshot'];
```


### `.` — `ComposerTransactionResultV1` (type)

Declared by `src/composer/types.ts` as `ComposerTransactionResultV1`.

```ts
type ComposerTransactionResultV1 = Awaited<ReturnType<PluginUiHostApi['applyComposer']>>;
```


### `.` — `ComposerTransactionV1` (type)

Declared by `src/composer/types.ts` as `ComposerTransactionV1`.

```ts
type ComposerTransactionV1 = Parameters<PluginUiHostApi['applyComposer']>[1];
```


### `.` — `ComposerViewStateV1` (type)

Declared by `src/composer/hooks.ts` as `ComposerViewStateV1`.

```ts
type ComposerViewStateV1 = Readonly<{
    result: ComposerReadResultV1 | null;
    error: PluginError | null;
    pending: 'initial' | 'refresh' | null;
    refresh(): Promise<void>;
}>;
```


### `.` — `ComposersService` (type)

Declared by `src/composer/service.ts` as `ComposersService`.

```ts
interface ComposersService {
    current(): ComposerHandle | null;
    active(options?: ComposerRequestOptions): Promise<ComposerHandle | null>;
    get(ref: ComposerRefV1, options?: ComposerRequestOptions): Promise<ComposerHandle | null>;
}
```


### `.` — `ContextMenu` (value)

Declared by `src/components/Overlay.tsx` as `ContextMenu`.

```ts
function ContextMenu(props: MenuProps): ReactElement;
```


### `.` — `Divider` (value)

Declared by `src/components/Foundation.tsx` as `Divider`.

```ts
function Divider(props: DividerProps): ReactElement;
```


### `.` — `DividerProps` (type)

Declared by `src/components/Foundation.tsx` as `DividerProps`.

```ts
type DividerProps = Readonly<{
    accessibilityLabel?: string;
    accessibilityLabelKey?: string;
    testID?: string;
}>;
```


### `.` — `Dropdown` (value)

Declared by `src/components/Overlay.tsx` as `Dropdown`.

```ts
function Dropdown(props: MenuProps): ReactElement;
```


### `.` — `EmptyState` (value)

Declared by `src/components/State.tsx` as `EmptyState`.

```ts
function EmptyState(props: EmptyStateProps): ReactElement;
```


### `.` — `EmptyStateProps` (type)

Declared by `src/components/State.tsx` as `EmptyStateProps`.

```ts
type EmptyStateProps = StateCopyProps;
```


### `.` — `ErrorState` (value)

Declared by `src/components/State.tsx` as `ErrorState`.

```ts
function ErrorState(props: ErrorStateProps): ReactElement;
```


### `.` — `ErrorStateProps` (type)

Declared by `src/components/State.tsx` as `ErrorStateProps`.

```ts
type ErrorStateProps = StateCopyProps;
```


### `.` — `Field` (value)

Declared by `src/components/Form.tsx` as `Field`.

```ts
function Field(props: FieldProps): ReactElement;
```


### `.` — `FieldProps` (type)

Declared by `src/components/Form.tsx` as `FieldProps`.

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

Declared by `src/components/Form.tsx` as `Form`.

```ts
const Form: ((props: FormProps) => ReactElement) & { Field: (props: FieldProps) => ReactElement; TextField: (props: TextFieldProps) => ReactElement; Toggle: (props: ToggleProps) => ReactElement; Select: (props: SelectProps) => ReactElement; ValidationMessage: ({ message, testID }: ValidationMessageProps) => ReactElement; Actions: ({ children }: FormActionsProps) => ReactElement; };
```


### `.` — `FormActionsProps` (type)

Declared by `src/components/Form.tsx` as `FormActionsProps`.

```ts
type FormActionsProps = Readonly<{
    children?: ReactNode;
}>;
```


### `.` — `FormProps` (type)

Declared by `src/components/Form.tsx` as `FormProps`.

```ts
type FormProps = Readonly<{
    hints: FormHints;
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

Declared by `src/components/Foundation.tsx` as `Heading`.

```ts
function Heading({ level = 2, focusTarget, testID, children, ...text }: HeadingProps): ReactElement;
```


### `.` — `HeadingProps` (type)

Declared by `src/components/Foundation.tsx` as `HeadingProps`.

```ts
type HeadingProps = AuthorText & Readonly<{
    level?: 1 | 2 | 3 | 4 | 5 | 6;
    focusTarget?: PluginUiFocusTarget;
    testID?: string;
    children?: ReactNode;
}>;
```


### `.` — `Icon` (value)

Declared by `src/components/Icon.tsx` as `Icon`.

```ts
function Icon({ name, size = 'medium', tone = 'default', accessibilityLabel, testID }: IconProps): ReactElement;
```


### `.` — `IconButton` (value)

Declared by `src/components/Button.tsx` as `IconButton`.

```ts
function IconButton({ accessibilityLabel, accessibilityLabelKey, icon, disabled, busy, selected, focusTarget, testID, onPress, }: IconButtonProps): ReactElement;
```


### `.` — `IconButtonProps` (type)

Declared by `src/components/Button.tsx` as `IconButtonProps`.

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

Declared by `src/components/Icon.tsx` as `IconName`.

```ts
type IconName = HappierIconName;
```


### `.` — `IconProps` (type)

Declared by `src/components/Icon.tsx` as `IconProps`.

```ts
type IconProps = Readonly<{
    name: IconName;
    size?: HappierIconSize;
    tone?: 'default' | 'secondary' | 'danger' | 'accent';
    accessibilityLabel?: string;
    testID?: string;
}>;
```


### `.` — `Image` (value)

Declared by `src/components/Image.tsx` as `Image`.

```ts
function Image({ resource, size = 'medium', accessibilityLabel, fallback = '•', testID }: ImageProps): ReactElement;
```


### `.` — `ImageProps` (type)

Declared by `src/components/Image.tsx` as `ImageProps`.

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

Declared by `src/components/List.tsx` as `Item`.

```ts
function Item(props: ListItemProps): ReactElement;
```


### `.` — `ItemGroup` (value)

Declared by `src/components/List.tsx` as `ItemGroup`.

```ts
function ItemGroup(props: ItemGroupProps): ReactElement;
```


### `.` — `ItemGroupProps` (type)

Declared by `src/components/List.tsx` as `ItemGroupProps`.

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

Declared by `src/components/List.tsx` as `ItemProps`.

```ts
type ItemProps = Readonly<{
    children?: ReactNode;
    title?: string;
    subtitle?: string;
    detail?: string;
    icon?: ReactNode;
    accessory?: ReactNode;
    tone?: HappierTone;
    onPress?: () => unknown;
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
    testID?: string;
    style?: HappierStyleProp;
}> & ItemSecondaryActionsProps;
```


### `.` — `Label` (value)

Declared by `src/components/Foundation.tsx` as `Label`.

```ts
function Label({ testID, children, ...text }: LabelProps): ReactElement;
```


### `.` — `LabelProps` (type)

Declared by `src/components/Foundation.tsx` as `LabelProps`.

```ts
type LabelProps = AuthorText & Readonly<{
    testID?: string;
    children?: ReactNode;
}>;
```


### `.` — `LayoutGap` (type)

Declared by `src/components/Layout.tsx` as `LayoutGap`.

```ts
type LayoutGap = HappierLayoutGap;
```


### `.` — `Link` (value)

Declared by `src/components/Foundation.tsx` as `Link`.

```ts
function Link({ title, titleKey, url, disabled, testID }: LinkProps): ReactElement;
```


### `.` — `LinkProps` (type)

Declared by `src/components/Foundation.tsx` as `LinkProps`.

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

Declared by `src/components/List.tsx` as `List`.

```ts
const List: (<Item>(props: ListProps<Item>) => ReactElement) & { Section: (props: ListSectionProps) => ReactElement; Item: (props: ListItemProps) => ReactElement; };
```


### `.` — `ListHeaderContext` (type)

Declared by `src/components/List.tsx` as `ListHeaderContext`.

```ts
type ListHeaderContext<Item> = Readonly<{
    selectedItem: Item | null;
}>;
```


### `.` — `ListItemProps` (type)

Declared by `src/components/List.tsx` as `ListItemProps`.

```ts
type ListItemProps = ItemProps;
```


### `.` — `ListProps` (type)

Declared by `src/components/List.tsx` as `ListProps`.

```ts
type ListProps<Item> = ListBaseProps & (VirtualizedListProps<Item> | StaticListProps);
```


### `.` — `ListSearchProps` (type)

Declared by `src/components/List.tsx` as `ListSearchProps`.

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

Declared by `src/components/List.tsx` as `ListSectionData`.

```ts
type ListSectionData<Item> = Readonly<{
    key: string;
    title: string;
    data: readonly Item[];
}>;
```


### `.` — `ListSectionProps` (type)

Declared by `src/components/List.tsx` as `ListSectionProps`.

```ts
type ListSectionProps = Readonly<{
    children?: ReactNode;
    title: string;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `.` — `ListSelectionProps` (type)

Declared by `src/components/List.tsx` as `ListSelectionProps`.

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

Declared by `src/components/State.tsx` as `LoadingState`.

```ts
function LoadingState(props: LoadingStateProps): ReactElement;
```


### `.` — `LoadingStateProps` (type)

Declared by `src/components/State.tsx` as `LoadingStateProps`.

```ts
type LoadingStateProps = StateCopyProps;
```


### `.` — `Markdown` (value)

Declared by `src/components/Content.tsx` as `Markdown`.

```ts
function Markdown({ value, selectable = true, testID }: MarkdownProps): ReactElement;
```


### `.` — `MarkdownProps` (type)

Declared by `src/components/Content.tsx` as `MarkdownProps`.

```ts
type MarkdownProps = Readonly<{
    value: string;
    selectable?: boolean;
    testID?: string;
}>;
```


### `.` — `Menu` (value)

Declared by `src/components/Overlay.tsx` as `Menu`.

```ts
function Menu(props: MenuProps): ReactElement;
```


### `.` — `MenuGroup` (type)

Declared by `src/components/Overlay.tsx` as `MenuGroup`.

```ts
type MenuGroup = Readonly<{
    id: string;
    accessibilityLabel: string;
    items: readonly MenuItem[];
}>;
```


### `.` — `MenuItem` (type)

Declared by `src/components/Overlay.tsx` as `MenuItem`.

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

Declared by `src/components/Overlay.tsx` as `MenuProps`.

```ts
type MenuProps = Omit<PopoverProps, 'children'> & MenuContentProps & Readonly<{
    radioGroups?: readonly MenuRadioGroup[];
    onSelect(id: string): void;
}>;
```


### `.` — `MenuRadioGroup` (type)

Declared by `src/components/Overlay.tsx` as `MenuRadioGroup`.

```ts
type MenuRadioGroup = Readonly<{
    id: string;
    accessibilityLabel: string;
    selectedId: string | null;
}>;
```


### `.` — `Metadata` (value)

Declared by `src/components/Foundation.tsx` as `Metadata`.

```ts
function Metadata(props: MetadataProps): ReactElement;
```


### `.` — `MetadataEntry` (type)

Declared by `src/components/Foundation.tsx` as `MetadataEntry`.

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

Declared by `src/components/Foundation.tsx` as `MetadataProps`.

```ts
type MetadataProps = Readonly<{
    title?: string;
    titleKey?: string;
    entries: readonly MetadataEntry[];
    testID?: string;
}>;
```


### `.` — `PluginAccessibilityFacts` (type)

Declared by `src/components/PluginUiProvider.tsx` as `PluginAccessibilityFacts`.

```ts
type PluginAccessibilityFacts = HappierUiAccessibility;
```


### `.` — `PluginActionExecution` (type)

Declared by `src/hostApi/executeAction.ts` as `PluginActionExecution`.

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

Declared by `src/hostApi/executeAction.ts` as `PluginActionExecutionController`.

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

Declared by `src/components/PluginUiProvider.tsx` as `PluginTranslate`.

```ts
type PluginTranslate = (key: string, fallback?: string, values?: PluginTranslationValues) => string;
```


### `.` — `PluginTranslationValues` (type)

Declared by `src/components/PluginUiProvider.tsx` as `PluginTranslationValues`.

```ts
type PluginTranslationValues = Readonly<Record<string, string | number>>;
```


### `.` — `PluginUiFocusTarget` (type)

Declared by `src/components/Focus.tsx` as `PluginUiFocusTarget`.

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

Declared by `src/hostApi/resourceStore.ts` as `PluginUiResourceError`.

```ts
type PluginUiResourceError = Readonly<{
    code?: string;
    diagnostics?: readonly string[];
    message: string;
}>;
```


### `.` — `PluginUiResourceReference` (type)

Declared by `src/hostApi/resourceStore.ts` as `PluginUiResourceReference`.

```ts
type PluginUiResourceReference = Parameters<PluginUiHostApi['readResource']>[0];
```


### `.` — `PluginUiResourceResult` (type)

Declared by `src/hostApi/index.ts` as `PluginUiResourceResult`.

```ts
type PluginUiResourceResult = Readonly<{
    resource: PluginUiResourceSnapshot;
    refresh: () => void;
}>;
```


### `.` — `PluginUiResourceSnapshot` (type)

Declared by `src/hostApi/resourceStore.ts` as `PluginUiResourceSnapshot`.

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

Declared by `src/components/State.tsx` as `PluginUiResourceState`.

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

Declared by `src/components/Overlay.tsx` as `Popover`.

```ts
function Popover(props: PopoverProps): ReactElement;
```


### `.` — `PopoverProps` (type)

Declared by `src/components/Overlay.tsx` as `PopoverProps`.

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
}>;
```


### `.` — `Progress` (value)

Declared by `src/components/Foundation.tsx` as `Progress`.

```ts
function Progress({ label, labelKey, ...props }: ProgressProps): ReactElement;
```


### `.` — `ProgressProps` (type)

Declared by `src/components/Foundation.tsx` as `ProgressProps`.

```ts
type ProgressProps = Readonly<{
    value?: number;
    label: string;
    labelKey?: string;
    testID?: string;
}>;
```


### `.` — `Row` (value)

Declared by `src/components/Layout.tsx` as `Row`.

```ts
function Row({ gap = 'medium', focusTarget, ...props }: RowProps): ReactElement;
```


### `.` — `RowProps` (type)

Declared by `src/components/Layout.tsx` as `RowProps`.

```ts
type RowProps = StackProps;
```


### `.` — `Screen` (value)

Declared by `src/components/Layout.tsx` as `Screen`.

```ts
function Screen({ children, safeArea = false, focusTarget, ...props }: ScreenProps): ReactElement;
```


### `.` — `ScreenProps` (type)

Declared by `src/components/Layout.tsx` as `ScreenProps`.

```ts
type ScreenProps = Readonly<{
    children?: ReactNode;
    safeArea?: boolean;
    focusTarget?: PluginUiFocusTarget;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `.` — `ScrollArea` (value)

Declared by `src/components/Layout.tsx` as `ScrollArea`.

```ts
function ScrollArea({ children, safeArea = false, ...props }: ScrollAreaProps): ReactElement;
```


### `.` — `ScrollAreaProps` (type)

Declared by `src/components/Layout.tsx` as `ScrollAreaProps`.

```ts
type ScrollAreaProps = Readonly<{
    children?: ReactNode;
    horizontal?: boolean;
    keyboardShouldPersistTaps?: HappierKeyboardShouldPersistTaps;
    onScroll?: (event: HappierScrollEvent) => void;
    scrollEventThrottle?: number;
    accessibilityLabel?: string;
    safeArea?: boolean;
    testID?: string;
    style?: HappierStyleProp;
    contentContainerStyle?: HappierStyleProp;
}>;
```


### `.` — `Select` (value)

Declared by `src/components/Form.tsx` as `Select`.

```ts
function Select(props: SelectProps): ReactElement;
```


### `.` — `SelectOption` (type)

Declared by `src/components/Form.tsx` as `SelectOption`.

```ts
type SelectOption = FormOption;
```


### `.` — `SelectProps` (type)

Declared by `src/components/Form.tsx` as `SelectProps`.

```ts
type SelectProps = Readonly<{
    label: string;
    options: readonly SelectOption[];
    value?: FormOptionValue | readonly FormOptionValue[];
    multiple?: boolean;
    maxSelections?: number;
    minimumSelections?: number;
    onChange: (value: FormOptionValue | readonly FormOptionValue[]) => void;
    disabled?: boolean;
    testID?: string;
}>;
```


### `.` — `Spinner` (value)

Declared by `src/components/Spinner.tsx` as `Spinner`.

```ts
function Spinner({ size, tone, accessibilityLabel, testID }: SpinnerProps): ReactElement;
```


### `.` — `SpinnerProps` (type)

Declared by `src/components/Spinner.tsx` as `SpinnerProps`.

```ts
type SpinnerProps = Readonly<{
    size?: SpinnerSize;
    tone?: TextTone;
    accessibilityLabel?: string;
    testID?: string;
}>;
```


### `.` — `SpinnerSize` (type)

Declared by `src/components/Spinner.tsx` as `SpinnerSize`.

```ts
type SpinnerSize = 'small' | 'large' | number;
```


### `.` — `Stack` (value)

Declared by `src/components/Layout.tsx` as `Stack`.

```ts
function Stack({ gap = 'medium', focusTarget, ...props }: StackProps): ReactElement;
```


### `.` — `StackProps` (type)

Declared by `src/components/Layout.tsx` as `StackProps`.

```ts
type StackProps = Readonly<{
    children?: ReactNode;
    gap?: LayoutGap;
    wrap?: boolean;
    align?: HappierAlignment;
    justify?: HappierJustification;
    focusTarget?: PluginUiFocusTarget;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `.` — `State` (value)

Declared by `src/components/State.tsx` as `State`.

```ts
function State<Value>({ resource, loading, empty, error, children, }: StateProps<Value>): ReactElement | null;
```


### `.` — `StateProps` (type)

Declared by `src/components/State.tsx` as `StateProps`.

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

Declared by `src/components/Status.tsx` as `Status`.

```ts
function Status({ tone, label, labelKey, pulsing, focusTarget, testID }: StatusProps): ReactElement;
```


### `.` — `StatusProps` (type)

Declared by `src/components/Status.tsx` as `StatusProps`.

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

Declared by `src/components/Surface.tsx` as `Surface`.

```ts
function Surface(props: SurfaceProps): ReactElement;
```


### `.` — `SurfacePadding` (type)

Declared by `src/components/Surface.tsx` as `SurfacePadding`.

```ts
type SurfacePadding = 'none' | 'small' | 'medium' | 'large';
```


### `.` — `SurfaceProps` (type)

Declared by `src/components/Surface.tsx` as `SurfaceProps`.

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

Declared by `src/components/Surface.tsx` as `SurfaceTone`.

```ts
type SurfaceTone = 'surface' | 'muted';
```


### `.` — `TabPanelActivity` (type)

Declared by `src/components/Tabs.tsx` as `TabPanelActivity`.

```ts
type TabPanelActivity = HappierTabPanelActivity;
```


### `.` — `Tabs` (value)

Declared by `src/components/Tabs.tsx` as `Tabs`.

```ts
const Tabs: ((props: TabsProps) => ReactElement) & { Item: (_props: TabsItemProps) => null; };
```


### `.` — `TabsItemProps` (type)

Declared by `src/components/Tabs.tsx` as `TabsItemProps`.

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

Declared by `src/components/Tabs.tsx` as `TabsProps`.

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

Declared by `src/components/TargetedSurface.tsx` as `TargetedSurface`.

```ts
function TargetedSurface<TInput extends JsonValue = JsonValue, TPointId extends string = string, TSurface extends PluginUiTargetedContributionSurfaceV1 = ContributionSurfaceHandle<TInput, TPointId>>({ surface, input, instanceKey, fallback }: TargetedSurfaceProps<TInput, TPointId, TSurface>): ReactElement | null;
```


### `.` — `TargetedSurfaceProps` (type)

Declared by `src/components/TargetedSurface.tsx` as `TargetedSurfaceProps`.

```ts
type TargetedSurfaceProps<TInput extends JsonValue = JsonValue, TPointId extends string = string, TSurface extends PluginUiTargetedContributionSurfaceV1 = ContributionSurfaceHandle<TInput, TPointId>> = Readonly<{
    surface: TSurface;
    input: TargetedSurfaceInput<TSurface>;
    instanceKey?: string;
    fallback?: ReactNode;
}>;
```


### `.` — `Text` (value)

Declared by `src/components/Text.tsx` as `Text`.

```ts
function Text({ value, valueKey, fallback, values, tone, variant, numberOfLines, selectable, accessibilityLabel, testID, children, }: TextProps): ReactElement;
```


### `.` — `TextField` (value)

Declared by `src/components/Form.tsx` as `TextField`.

```ts
function TextField(props: TextFieldProps): ReactElement;
```


### `.` — `TextFieldProps` (type)

Declared by `src/components/Form.tsx` as `TextFieldProps`.

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
    focusTarget?: PluginUiFocusTarget;
    testID?: string;
}>;
```


### `.` — `TextProps` (type)

Declared by `src/components/Text.tsx` as `TextProps`.

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


### `.` — `TextTone` (type)

Declared by `src/components/Text.tsx` as `TextTone`.

```ts
type TextTone = HappierTone;
```


### `.` — `TextVariant` (type)

Declared by `src/components/Text.tsx` as `TextVariant`.

```ts
type TextVariant = HappierTextVariant;
```


### `.` — `Toggle` (value)

Declared by `src/components/Form.tsx` as `Toggle`.

```ts
function Toggle(props: ToggleProps): ReactElement;
```


### `.` — `ToggleProps` (type)

Declared by `src/components/Form.tsx` as `ToggleProps`.

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

Declared by `src/surfaceEntry.tsx` as `UiSurfaceComponent`.

```ts
type UiSurfaceComponent = ComponentType<RenderContext>;
```


### `.` — `ValidationMessage` (value)

Declared by `src/components/Form.tsx` as `ValidationMessage`.

```ts
function ValidationMessage({ message, testID }: ValidationMessageProps): ReactElement;
```


### `.` — `ValidationMessageProps` (type)

Declared by `src/components/Form.tsx` as `ValidationMessageProps`.

```ts
type ValidationMessageProps = Readonly<{
    message: string;
    testID?: string;
}>;
```


### `.` — `defineUiSurface` (value)

Declared by `src/surfaceEntry.tsx` as `defineUiSurface`.

```ts
function defineUiSurface(Surface: UiSurfaceComponent): RenderSurface;
```


### `.` — `useComposer` (value)

Declared by `src/composer/hooks.ts` as `useComposer`.

```ts
function useComposer(): ComposersService;
```


### `.` — `useComposerView` (value)

Declared by `src/composer/hooks.ts` as `useComposerView`.

```ts
function useComposerView(handle: ComposerHandle | null): ComposerViewStateV1;
```


### `.` — `useExecutePluginAction` (value)

Declared by `src/hostApi/executeAction.ts` as `useExecutePluginAction`.

```ts
function useExecutePluginAction<TAction extends PluginUiActionReference>(action: TAction, input?: NoInfer<PluginUiActionInputFor<NoInfer<TAction>>>): PluginActionExecutionController<PluginUiActionResultFor<NoInfer<TAction>>, PluginUiActionInputFor<NoInfer<TAction>>>;
function useExecutePluginAction(action: PluginUiActionReference, input?: JsonValue): PluginActionExecutionController<JsonValue, JsonValue>;
```


### `.` — `useLivePluginResource` (value)

Declared by `src/hostApi/index.ts` as `useLivePluginResource`.

```ts
function useLivePluginResource(resource: PluginUiResourceReference): PluginUiResourceResult;
```


### `.` — `usePluginAccessibility` (value)

Declared by `src/components/PluginUiProvider.tsx` as `usePluginAccessibility`.

```ts
function usePluginAccessibility(): PluginAccessibilityFacts;
```


### `.` — `usePluginBrandDisplayName` (value)

Declared by `src/components/Image.tsx` as `usePluginBrandDisplayName`.

```ts
function usePluginBrandDisplayName(pluginId?: string): string | undefined;
```


### `.` — `usePluginBrandDisplayNameResolver` (value)

Declared by `src/components/Image.tsx` as `usePluginBrandDisplayNameResolver`.

```ts
function usePluginBrandDisplayNameResolver(): (pluginId?: string) => string | undefined;
```


### `.` — `usePluginHostApi` (value)

Declared by `src/hostApi/context.ts` as `usePluginHostApi`.

```ts
function usePluginHostApi(): PluginUiHostApi;
```


### `.` — `usePluginResource` (value)

Declared by `src/hostApi/index.ts` as `usePluginResource`.

```ts
function usePluginResource(resource: PluginUiResourceReference): PluginUiResourceResult;
```


### `.` — `usePluginTheme` (value)

Declared by `src/components/PluginUiProvider.tsx` as `usePluginTheme`.

```ts
function usePluginTheme(): PluginUiThemeV1;
```


### `.` — `usePluginTranslation` (value)

Declared by `src/components/PluginUiProvider.tsx` as `usePluginTranslation`.

```ts
function usePluginTranslation(): PluginTranslate;
```


### `.` — `usePluginUiFocusTarget` (value)

Declared by `src/components/Focus.tsx` as `usePluginUiFocusTarget`.

```ts
function usePluginUiFocusTarget(): PluginUiFocusTarget;
```


### `.` — `useSurfaceContext` (value)

Declared by `src/components/PluginUiProvider.tsx` as `useSurfaceContext`.

```ts
function useSurfaceContext(): SurfaceContext;
```


### `.` — `useTabPanelActivity` (value)

Declared by `src/components/Tabs.tsx` as `useTabPanelActivity`.

```ts
function useTabPanelActivity(): TabPanelActivity;
```


### `./advanced` — `PluginHostApiProvider` (value)

Declared by `src/hostApi/context.ts` as `PluginHostApiProvider`.

```ts
function PluginHostApiProvider(props: PluginHostApiProviderProps);
```


### `./advanced` — `PluginHostApiProviderProps` (type)

Declared by `src/hostApi/context.ts` as `PluginHostApiProviderProps`.

```ts
type PluginHostApiProviderProps = Readonly<{
    hostApi: PluginUiHostApi;
    children?: ReactNode;
}>;
```


### `./advanced` — `PluginUiProvider` (value)

Declared by `src/components/PluginUiProvider.tsx` as `PluginUiProvider`.

```ts
function PluginUiProvider(props: PluginUiProviderProps);
```


### `./advanced` — `PluginUiProviderProps` (type)

Declared by `src/components/PluginUiProvider.tsx` as `PluginUiProviderProps`.

```ts
type PluginUiProviderProps = Readonly<{
    hostApi: PluginUiHostApi;
    context?: SurfaceContext;
    children?: ReactNode;
}>;
```


### `./advanced` — `PluginUiResourceAccountLifetime` (type)

Declared by `src/hostApi/resourceStore.ts` as `PluginUiResourceAccountLifetime`.

```ts
type PluginUiResourceAccountLifetime = Readonly<{
    isCurrent(): boolean;
    onRetire(cancel: () => void): Disposable;
}>;
```


### `./advanced` — `PluginUiResourceClient` (type)

Declared by `src/hostApi/resourceStore.ts` as `PluginUiResourceClient`.

```ts
type PluginUiResourceClient = Readonly<{
    readResource: PluginUiHostApi['readResource'];
    watchResource?: (...args: Parameters<PluginUiHostApi['watchResource']>) => Promise<Disposable & Readonly<{
        admittedDigest?: string;
    }>>;
}>;
```


### `./advanced` — `PluginUiResourceEntry` (type)

Declared by `src/hostApi/resourceStore.ts` as `PluginUiResourceEntry`.

```ts
type PluginUiResourceEntry = Readonly<{
    getSnapshot(): PluginUiResourceSnapshot;
    subscribe(listener: () => void, live: boolean): () => void;
    refresh(): void;
}>;
```


### `./advanced` — `PluginUiResourceStore` (type)

Declared by `src/hostApi/resourceStore.ts` as `PluginUiResourceStore`.

```ts
type PluginUiResourceStore = Readonly<{
    getEntry(resource: PluginUiResourceReference): PluginUiResourceEntry;
    dispose(): void;
}>;
```


### `./advanced` — `createPluginUiHostApiResourceClient` (value)

Declared by `src/hostApi/resourceStore.ts` as `createPluginUiHostApiResourceClient`.

```ts
function createPluginUiHostApiResourceClient(hostApi: PluginUiHostApi): PluginUiResourceClient;
```


### `./advanced` — `createPluginUiResourceStore` (value)

Declared by `src/hostApi/resourceStore.ts` as `createPluginUiResourceStore`.

```ts
function createPluginUiResourceStore(input: Readonly<{
    client: PluginUiResourceClient;
    accountLifetime?: PluginUiResourceAccountLifetime | null;
    pluginId?: string;
}>): PluginUiResourceStore;
```


### `./components` — `Action` (value)

Declared by `src/components/Action.tsx` as `Action`.

```ts
const Action: { readonly Execute: <TAction extends PluginUiActionReference>({ action, input, onSettled, ...chrome }: ActionExecuteProps<TAction>) => ReactElement; readonly Copy: ({ value, ...chrome }: ActionCopyProps) => ReactElement; readonly OpenExternal: ({ url, ...chrome }: ActionOpenExternalProps) => ReactElement; readonly OpenSurface: ({ view, input, ...chrome }: ActionOpenSurfaceProps) => ReactElement; readonly Refresh: ({ onRefresh, ...chrome }: ActionRefreshProps) => ReactElement; };
```


### `./components` — `ActionCopyProps` (type)

Declared by `src/components/Action.tsx` as `ActionCopyProps`.

```ts
type ActionCopyProps = ActionChromeProps & Readonly<{
    value: string;
}>;
```


### `./components` — `ActionExecuteProps` (type)

Declared by `src/components/Action.tsx` as `ActionExecuteProps`.

```ts
type ActionExecuteProps<TAction extends PluginUiActionReference = PluginUiActionReference> = ActionChromeProps & Readonly<{
    action: TAction;
    input?: NoInfer<PluginUiActionInputFor<NoInfer<TAction>>>;
    onSettled?: (execution: PluginActionExecution<PluginUiActionResultFor<NoInfer<TAction>>>) => void;
}>;
```


### `./components` — `ActionOpenExternalProps` (type)

Declared by `src/components/Action.tsx` as `ActionOpenExternalProps`.

```ts
type ActionOpenExternalProps = ActionChromeProps & Readonly<{
    url: string;
}>;
```


### `./components` — `ActionOpenSurfaceProps` (type)

Declared by `src/components/Action.tsx` as `ActionOpenSurfaceProps`.

```ts
type ActionOpenSurfaceProps = ActionChromeProps & Readonly<{
    view: PluginReference;
    input?: JsonValue;
}>;
```


### `./components` — `ActionPanel` (value)

Declared by `src/components/Action.tsx` as `ActionPanel`.

```ts
const ActionPanel: (({ title, titleKey, testID, children }: ActionGroupProps) => ReactElement) & { Section: ({ title, titleKey, testID, children }: ActionGroupProps) => ReactElement; };
```


### `./components` — `ActionPanelProps` (type)

Declared by `src/components/Action.tsx` as `ActionPanelProps`.

```ts
type ActionPanelProps = ActionGroupProps;
```


### `./components` — `ActionPanelSectionProps` (type)

Declared by `src/components/Action.tsx` as `ActionPanelSectionProps`.

```ts
type ActionPanelSectionProps = ActionGroupProps;
```


### `./components` — `ActionRefreshProps` (type)

Declared by `src/components/Action.tsx` as `ActionRefreshProps`.

```ts
type ActionRefreshProps = ActionChromeProps & Readonly<{
    onRefresh: () => unknown;
}>;
```


### `./components` — `Badge` (value)

Declared by `src/components/Foundation.tsx` as `Badge`.

```ts
function Badge({ tone = 'neutral', testID, children, ...text }: BadgeProps): ReactElement;
```


### `./components` — `BadgeProps` (type)

Declared by `src/components/Foundation.tsx` as `BadgeProps`.

```ts
type BadgeProps = AuthorText & Readonly<{
    tone?: HappierTone;
    testID?: string;
    children?: ReactNode;
}>;
```


### `./components` — `Banner` (value)

Declared by `src/components/Foundation.tsx` as `Banner`.

```ts
function Banner({ tone = 'info', title, titleKey, description, descriptionKey, ...props }: BannerProps): ReactElement;
```


### `./components` — `BannerProps` (type)

Declared by `src/components/Foundation.tsx` as `BannerProps`.

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

Declared by `src/components/Image.tsx` as `BrandMark`.

```ts
function BrandMark({ pluginId, size, showName = false, externallyLabelled = false, testID }: BrandMarkProps): ReactElement;
```


### `./components` — `BrandMarkProps` (type)

Declared by `src/components/Image.tsx` as `BrandMarkProps`.

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

Declared by `src/components/Button.tsx` as `Button`.

```ts
function Button({ title, titleKey, accessibilityLabelKey, variant = 'primary', disabled, busy, icon, accessibilityLabel, focusTarget, testID, onPress, children, }: ButtonProps): ReactElement;
```


### `./components` — `ButtonProps` (type)

Declared by `src/components/Button.tsx` as `ButtonProps`.

```ts
type ButtonProps = ButtonWithVisibleTitleProps | ButtonWithExplicitAccessibleNameProps;
```


### `./components` — `ButtonVariant` (type)

Declared by `src/components/Button.tsx` as `ButtonVariant`.

```ts
type ButtonVariant = 'primary' | 'secondary' | 'plain';
```


### `./components` — `Card` (value)

Declared by `src/components/Surface.tsx` as `Card`.

```ts
function Card({ padding = 'medium', ...props }: CardProps): ReactElement;
```


### `./components` — `CardProps` (type)

Declared by `src/components/Surface.tsx` as `CardProps`.

```ts
type CardProps = SurfaceProps;
```


### `./components` — `CodeBlock` (value)

Declared by `src/components/Content.tsx` as `CodeBlock`.

```ts
function CodeBlock({ code, language, selectable = true, copyLabel, copiedLabel, testID, }: CodeBlockProps): ReactElement;
```


### `./components` — `CodeBlockProps` (type)

Declared by `src/components/Content.tsx` as `CodeBlockProps`.

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

Declared by `src/components/Overlay.tsx` as `ContextMenu`.

```ts
function ContextMenu(props: MenuProps): ReactElement;
```


### `./components` — `Divider` (value)

Declared by `src/components/Foundation.tsx` as `Divider`.

```ts
function Divider(props: DividerProps): ReactElement;
```


### `./components` — `DividerProps` (type)

Declared by `src/components/Foundation.tsx` as `DividerProps`.

```ts
type DividerProps = Readonly<{
    accessibilityLabel?: string;
    accessibilityLabelKey?: string;
    testID?: string;
}>;
```


### `./components` — `Dropdown` (value)

Declared by `src/components/Overlay.tsx` as `Dropdown`.

```ts
function Dropdown(props: MenuProps): ReactElement;
```


### `./components` — `EmptyState` (value)

Declared by `src/components/State.tsx` as `EmptyState`.

```ts
function EmptyState(props: EmptyStateProps): ReactElement;
```


### `./components` — `EmptyStateProps` (type)

Declared by `src/components/State.tsx` as `EmptyStateProps`.

```ts
type EmptyStateProps = StateCopyProps;
```


### `./components` — `ErrorState` (value)

Declared by `src/components/State.tsx` as `ErrorState`.

```ts
function ErrorState(props: ErrorStateProps): ReactElement;
```


### `./components` — `ErrorStateProps` (type)

Declared by `src/components/State.tsx` as `ErrorStateProps`.

```ts
type ErrorStateProps = StateCopyProps;
```


### `./components` — `Field` (value)

Declared by `src/components/Form.tsx` as `Field`.

```ts
function Field(props: FieldProps): ReactElement;
```


### `./components` — `FieldProps` (type)

Declared by `src/components/Form.tsx` as `FieldProps`.

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

Declared by `src/components/Form.tsx` as `Form`.

```ts
const Form: ((props: FormProps) => ReactElement) & { Field: (props: FieldProps) => ReactElement; TextField: (props: TextFieldProps) => ReactElement; Toggle: (props: ToggleProps) => ReactElement; Select: (props: SelectProps) => ReactElement; ValidationMessage: ({ message, testID }: ValidationMessageProps) => ReactElement; Actions: ({ children }: FormActionsProps) => ReactElement; };
```


### `./components` — `FormActionsProps` (type)

Declared by `src/components/Form.tsx` as `FormActionsProps`.

```ts
type FormActionsProps = Readonly<{
    children?: ReactNode;
}>;
```


### `./components` — `FormProps` (type)

Declared by `src/components/Form.tsx` as `FormProps`.

```ts
type FormProps = Readonly<{
    hints: FormHints;
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

Declared by `src/components/Foundation.tsx` as `Heading`.

```ts
function Heading({ level = 2, focusTarget, testID, children, ...text }: HeadingProps): ReactElement;
```


### `./components` — `HeadingProps` (type)

Declared by `src/components/Foundation.tsx` as `HeadingProps`.

```ts
type HeadingProps = AuthorText & Readonly<{
    level?: 1 | 2 | 3 | 4 | 5 | 6;
    focusTarget?: PluginUiFocusTarget;
    testID?: string;
    children?: ReactNode;
}>;
```


### `./components` — `Icon` (value)

Declared by `src/components/Icon.tsx` as `Icon`.

```ts
function Icon({ name, size = 'medium', tone = 'default', accessibilityLabel, testID }: IconProps): ReactElement;
```


### `./components` — `IconButton` (value)

Declared by `src/components/Button.tsx` as `IconButton`.

```ts
function IconButton({ accessibilityLabel, accessibilityLabelKey, icon, disabled, busy, selected, focusTarget, testID, onPress, }: IconButtonProps): ReactElement;
```


### `./components` — `IconButtonProps` (type)

Declared by `src/components/Button.tsx` as `IconButtonProps`.

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

Declared by `src/components/Icon.tsx` as `IconName`.

```ts
type IconName = HappierIconName;
```


### `./components` — `IconProps` (type)

Declared by `src/components/Icon.tsx` as `IconProps`.

```ts
type IconProps = Readonly<{
    name: IconName;
    size?: HappierIconSize;
    tone?: 'default' | 'secondary' | 'danger' | 'accent';
    accessibilityLabel?: string;
    testID?: string;
}>;
```


### `./components` — `Image` (value)

Declared by `src/components/Image.tsx` as `Image`.

```ts
function Image({ resource, size = 'medium', accessibilityLabel, fallback = '•', testID }: ImageProps): ReactElement;
```


### `./components` — `ImageProps` (type)

Declared by `src/components/Image.tsx` as `ImageProps`.

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

Declared by `src/components/List.tsx` as `Item`.

```ts
function Item(props: ListItemProps): ReactElement;
```


### `./components` — `ItemGroup` (value)

Declared by `src/components/List.tsx` as `ItemGroup`.

```ts
function ItemGroup(props: ItemGroupProps): ReactElement;
```


### `./components` — `ItemGroupProps` (type)

Declared by `src/components/List.tsx` as `ItemGroupProps`.

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

Declared by `src/components/List.tsx` as `ItemProps`.

```ts
type ItemProps = Readonly<{
    children?: ReactNode;
    title?: string;
    subtitle?: string;
    detail?: string;
    icon?: ReactNode;
    accessory?: ReactNode;
    tone?: HappierTone;
    onPress?: () => unknown;
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
    testID?: string;
    style?: HappierStyleProp;
}> & ItemSecondaryActionsProps;
```


### `./components` — `Label` (value)

Declared by `src/components/Foundation.tsx` as `Label`.

```ts
function Label({ testID, children, ...text }: LabelProps): ReactElement;
```


### `./components` — `LabelProps` (type)

Declared by `src/components/Foundation.tsx` as `LabelProps`.

```ts
type LabelProps = AuthorText & Readonly<{
    testID?: string;
    children?: ReactNode;
}>;
```


### `./components` — `LayoutGap` (type)

Declared by `src/components/Layout.tsx` as `LayoutGap`.

```ts
type LayoutGap = HappierLayoutGap;
```


### `./components` — `Link` (value)

Declared by `src/components/Foundation.tsx` as `Link`.

```ts
function Link({ title, titleKey, url, disabled, testID }: LinkProps): ReactElement;
```


### `./components` — `LinkProps` (type)

Declared by `src/components/Foundation.tsx` as `LinkProps`.

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

Declared by `src/components/List.tsx` as `List`.

```ts
const List: (<Item>(props: ListProps<Item>) => ReactElement) & { Section: (props: ListSectionProps) => ReactElement; Item: (props: ListItemProps) => ReactElement; };
```


### `./components` — `ListHeaderContext` (type)

Declared by `src/components/List.tsx` as `ListHeaderContext`.

```ts
type ListHeaderContext<Item> = Readonly<{
    selectedItem: Item | null;
}>;
```


### `./components` — `ListItemProps` (type)

Declared by `src/components/List.tsx` as `ListItemProps`.

```ts
type ListItemProps = ItemProps;
```


### `./components` — `ListProps` (type)

Declared by `src/components/List.tsx` as `ListProps`.

```ts
type ListProps<Item> = ListBaseProps & (VirtualizedListProps<Item> | StaticListProps);
```


### `./components` — `ListSearchProps` (type)

Declared by `src/components/List.tsx` as `ListSearchProps`.

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

Declared by `src/components/List.tsx` as `ListSectionData`.

```ts
type ListSectionData<Item> = Readonly<{
    key: string;
    title: string;
    data: readonly Item[];
}>;
```


### `./components` — `ListSectionProps` (type)

Declared by `src/components/List.tsx` as `ListSectionProps`.

```ts
type ListSectionProps = Readonly<{
    children?: ReactNode;
    title: string;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `./components` — `ListSelectionProps` (type)

Declared by `src/components/List.tsx` as `ListSelectionProps`.

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

Declared by `src/components/State.tsx` as `LoadingState`.

```ts
function LoadingState(props: LoadingStateProps): ReactElement;
```


### `./components` — `LoadingStateProps` (type)

Declared by `src/components/State.tsx` as `LoadingStateProps`.

```ts
type LoadingStateProps = StateCopyProps;
```


### `./components` — `Markdown` (value)

Declared by `src/components/Content.tsx` as `Markdown`.

```ts
function Markdown({ value, selectable = true, testID }: MarkdownProps): ReactElement;
```


### `./components` — `MarkdownProps` (type)

Declared by `src/components/Content.tsx` as `MarkdownProps`.

```ts
type MarkdownProps = Readonly<{
    value: string;
    selectable?: boolean;
    testID?: string;
}>;
```


### `./components` — `Menu` (value)

Declared by `src/components/Overlay.tsx` as `Menu`.

```ts
function Menu(props: MenuProps): ReactElement;
```


### `./components` — `MenuGroup` (type)

Declared by `src/components/Overlay.tsx` as `MenuGroup`.

```ts
type MenuGroup = Readonly<{
    id: string;
    accessibilityLabel: string;
    items: readonly MenuItem[];
}>;
```


### `./components` — `MenuItem` (type)

Declared by `src/components/Overlay.tsx` as `MenuItem`.

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

Declared by `src/components/Overlay.tsx` as `MenuProps`.

```ts
type MenuProps = Omit<PopoverProps, 'children'> & MenuContentProps & Readonly<{
    radioGroups?: readonly MenuRadioGroup[];
    onSelect(id: string): void;
}>;
```


### `./components` — `MenuRadioGroup` (type)

Declared by `src/components/Overlay.tsx` as `MenuRadioGroup`.

```ts
type MenuRadioGroup = Readonly<{
    id: string;
    accessibilityLabel: string;
    selectedId: string | null;
}>;
```


### `./components` — `Metadata` (value)

Declared by `src/components/Foundation.tsx` as `Metadata`.

```ts
function Metadata(props: MetadataProps): ReactElement;
```


### `./components` — `MetadataEntry` (type)

Declared by `src/components/Foundation.tsx` as `MetadataEntry`.

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

Declared by `src/components/Foundation.tsx` as `MetadataProps`.

```ts
type MetadataProps = Readonly<{
    title?: string;
    titleKey?: string;
    entries: readonly MetadataEntry[];
    testID?: string;
}>;
```


### `./components` — `PluginAccessibilityFacts` (type)

Declared by `src/components/PluginUiProvider.tsx` as `PluginAccessibilityFacts`.

```ts
type PluginAccessibilityFacts = HappierUiAccessibility;
```


### `./components` — `PluginTranslate` (type)

Declared by `src/components/PluginUiProvider.tsx` as `PluginTranslate`.

```ts
type PluginTranslate = (key: string, fallback?: string, values?: PluginTranslationValues) => string;
```


### `./components` — `PluginTranslationValues` (type)

Declared by `src/components/PluginUiProvider.tsx` as `PluginTranslationValues`.

```ts
type PluginTranslationValues = Readonly<Record<string, string | number>>;
```


### `./components` — `PluginUiFocusTarget` (type)

Declared by `src/components/Focus.tsx` as `PluginUiFocusTarget`.

```ts
type PluginUiFocusTarget = Readonly<{
    focus(): boolean;
}>;
```


### `./components` — `PluginUiResourceState` (type)

Declared by `src/components/State.tsx` as `PluginUiResourceState`.

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

Declared by `src/components/Overlay.tsx` as `Popover`.

```ts
function Popover(props: PopoverProps): ReactElement;
```


### `./components` — `PopoverProps` (type)

Declared by `src/components/Overlay.tsx` as `PopoverProps`.

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
}>;
```


### `./components` — `Progress` (value)

Declared by `src/components/Foundation.tsx` as `Progress`.

```ts
function Progress({ label, labelKey, ...props }: ProgressProps): ReactElement;
```


### `./components` — `ProgressProps` (type)

Declared by `src/components/Foundation.tsx` as `ProgressProps`.

```ts
type ProgressProps = Readonly<{
    value?: number;
    label: string;
    labelKey?: string;
    testID?: string;
}>;
```


### `./components` — `Row` (value)

Declared by `src/components/Layout.tsx` as `Row`.

```ts
function Row({ gap = 'medium', focusTarget, ...props }: RowProps): ReactElement;
```


### `./components` — `RowProps` (type)

Declared by `src/components/Layout.tsx` as `RowProps`.

```ts
type RowProps = StackProps;
```


### `./components` — `Screen` (value)

Declared by `src/components/Layout.tsx` as `Screen`.

```ts
function Screen({ children, safeArea = false, focusTarget, ...props }: ScreenProps): ReactElement;
```


### `./components` — `ScreenProps` (type)

Declared by `src/components/Layout.tsx` as `ScreenProps`.

```ts
type ScreenProps = Readonly<{
    children?: ReactNode;
    safeArea?: boolean;
    focusTarget?: PluginUiFocusTarget;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `./components` — `ScrollArea` (value)

Declared by `src/components/Layout.tsx` as `ScrollArea`.

```ts
function ScrollArea({ children, safeArea = false, ...props }: ScrollAreaProps): ReactElement;
```


### `./components` — `ScrollAreaProps` (type)

Declared by `src/components/Layout.tsx` as `ScrollAreaProps`.

```ts
type ScrollAreaProps = Readonly<{
    children?: ReactNode;
    horizontal?: boolean;
    keyboardShouldPersistTaps?: HappierKeyboardShouldPersistTaps;
    onScroll?: (event: HappierScrollEvent) => void;
    scrollEventThrottle?: number;
    accessibilityLabel?: string;
    safeArea?: boolean;
    testID?: string;
    style?: HappierStyleProp;
    contentContainerStyle?: HappierStyleProp;
}>;
```


### `./components` — `Select` (value)

Declared by `src/components/Form.tsx` as `Select`.

```ts
function Select(props: SelectProps): ReactElement;
```


### `./components` — `SelectOption` (type)

Declared by `src/components/Form.tsx` as `SelectOption`.

```ts
type SelectOption = FormOption;
```


### `./components` — `SelectProps` (type)

Declared by `src/components/Form.tsx` as `SelectProps`.

```ts
type SelectProps = Readonly<{
    label: string;
    options: readonly SelectOption[];
    value?: FormOptionValue | readonly FormOptionValue[];
    multiple?: boolean;
    maxSelections?: number;
    minimumSelections?: number;
    onChange: (value: FormOptionValue | readonly FormOptionValue[]) => void;
    disabled?: boolean;
    testID?: string;
}>;
```


### `./components` — `Spinner` (value)

Declared by `src/components/Spinner.tsx` as `Spinner`.

```ts
function Spinner({ size, tone, accessibilityLabel, testID }: SpinnerProps): ReactElement;
```


### `./components` — `SpinnerProps` (type)

Declared by `src/components/Spinner.tsx` as `SpinnerProps`.

```ts
type SpinnerProps = Readonly<{
    size?: SpinnerSize;
    tone?: TextTone;
    accessibilityLabel?: string;
    testID?: string;
}>;
```


### `./components` — `SpinnerSize` (type)

Declared by `src/components/Spinner.tsx` as `SpinnerSize`.

```ts
type SpinnerSize = 'small' | 'large' | number;
```


### `./components` — `Stack` (value)

Declared by `src/components/Layout.tsx` as `Stack`.

```ts
function Stack({ gap = 'medium', focusTarget, ...props }: StackProps): ReactElement;
```


### `./components` — `StackProps` (type)

Declared by `src/components/Layout.tsx` as `StackProps`.

```ts
type StackProps = Readonly<{
    children?: ReactNode;
    gap?: LayoutGap;
    wrap?: boolean;
    align?: HappierAlignment;
    justify?: HappierJustification;
    focusTarget?: PluginUiFocusTarget;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `./components` — `State` (value)

Declared by `src/components/State.tsx` as `State`.

```ts
function State<Value>({ resource, loading, empty, error, children, }: StateProps<Value>): ReactElement | null;
```


### `./components` — `StateProps` (type)

Declared by `src/components/State.tsx` as `StateProps`.

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

Declared by `src/components/Status.tsx` as `Status`.

```ts
function Status({ tone, label, labelKey, pulsing, focusTarget, testID }: StatusProps): ReactElement;
```


### `./components` — `StatusProps` (type)

Declared by `src/components/Status.tsx` as `StatusProps`.

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

Declared by `src/components/Surface.tsx` as `Surface`.

```ts
function Surface(props: SurfaceProps): ReactElement;
```


### `./components` — `SurfacePadding` (type)

Declared by `src/components/Surface.tsx` as `SurfacePadding`.

```ts
type SurfacePadding = 'none' | 'small' | 'medium' | 'large';
```


### `./components` — `SurfaceProps` (type)

Declared by `src/components/Surface.tsx` as `SurfaceProps`.

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

Declared by `src/components/Surface.tsx` as `SurfaceTone`.

```ts
type SurfaceTone = 'surface' | 'muted';
```


### `./components` — `TabPanelActivity` (type)

Declared by `src/components/Tabs.tsx` as `TabPanelActivity`.

```ts
type TabPanelActivity = HappierTabPanelActivity;
```


### `./components` — `Tabs` (value)

Declared by `src/components/Tabs.tsx` as `Tabs`.

```ts
const Tabs: ((props: TabsProps) => ReactElement) & { Item: (_props: TabsItemProps) => null; };
```


### `./components` — `TabsItemProps` (type)

Declared by `src/components/Tabs.tsx` as `TabsItemProps`.

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

Declared by `src/components/Tabs.tsx` as `TabsProps`.

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

Declared by `src/components/TargetedSurface.tsx` as `TargetedSurface`.

```ts
function TargetedSurface<TInput extends JsonValue = JsonValue, TPointId extends string = string, TSurface extends PluginUiTargetedContributionSurfaceV1 = ContributionSurfaceHandle<TInput, TPointId>>({ surface, input, instanceKey, fallback }: TargetedSurfaceProps<TInput, TPointId, TSurface>): ReactElement | null;
```


### `./components` — `TargetedSurfaceProps` (type)

Declared by `src/components/TargetedSurface.tsx` as `TargetedSurfaceProps`.

```ts
type TargetedSurfaceProps<TInput extends JsonValue = JsonValue, TPointId extends string = string, TSurface extends PluginUiTargetedContributionSurfaceV1 = ContributionSurfaceHandle<TInput, TPointId>> = Readonly<{
    surface: TSurface;
    input: TargetedSurfaceInput<TSurface>;
    instanceKey?: string;
    fallback?: ReactNode;
}>;
```


### `./components` — `Text` (value)

Declared by `src/components/Text.tsx` as `Text`.

```ts
function Text({ value, valueKey, fallback, values, tone, variant, numberOfLines, selectable, accessibilityLabel, testID, children, }: TextProps): ReactElement;
```


### `./components` — `TextField` (value)

Declared by `src/components/Form.tsx` as `TextField`.

```ts
function TextField(props: TextFieldProps): ReactElement;
```


### `./components` — `TextFieldProps` (type)

Declared by `src/components/Form.tsx` as `TextFieldProps`.

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
    focusTarget?: PluginUiFocusTarget;
    testID?: string;
}>;
```


### `./components` — `TextProps` (type)

Declared by `src/components/Text.tsx` as `TextProps`.

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


### `./components` — `TextTone` (type)

Declared by `src/components/Text.tsx` as `TextTone`.

```ts
type TextTone = HappierTone;
```


### `./components` — `TextVariant` (type)

Declared by `src/components/Text.tsx` as `TextVariant`.

```ts
type TextVariant = HappierTextVariant;
```


### `./components` — `Toggle` (value)

Declared by `src/components/Form.tsx` as `Toggle`.

```ts
function Toggle(props: ToggleProps): ReactElement;
```


### `./components` — `ToggleProps` (type)

Declared by `src/components/Form.tsx` as `ToggleProps`.

```ts
type ToggleProps = Readonly<{
    label: string;
    value: boolean;
    onChange: (value: boolean) => void;
    disabled?: boolean;
    testID?: string;
}>;
```


### `./components` — `ValidationMessage` (value)

Declared by `src/components/Form.tsx` as `ValidationMessage`.

```ts
function ValidationMessage({ message, testID }: ValidationMessageProps): ReactElement;
```


### `./components` — `ValidationMessageProps` (type)

Declared by `src/components/Form.tsx` as `ValidationMessageProps`.

```ts
type ValidationMessageProps = Readonly<{
    message: string;
    testID?: string;
}>;
```


### `./components` — `usePluginAccessibility` (value)

Declared by `src/components/PluginUiProvider.tsx` as `usePluginAccessibility`.

```ts
function usePluginAccessibility(): PluginAccessibilityFacts;
```


### `./components` — `usePluginBrandDisplayName` (value)

Declared by `src/components/Image.tsx` as `usePluginBrandDisplayName`.

```ts
function usePluginBrandDisplayName(pluginId?: string): string | undefined;
```


### `./components` — `usePluginBrandDisplayNameResolver` (value)

Declared by `src/components/Image.tsx` as `usePluginBrandDisplayNameResolver`.

```ts
function usePluginBrandDisplayNameResolver(): (pluginId?: string) => string | undefined;
```


### `./components` — `usePluginTheme` (value)

Declared by `src/components/PluginUiProvider.tsx` as `usePluginTheme`.

```ts
function usePluginTheme(): PluginUiThemeV1;
```


### `./components` — `usePluginTranslation` (value)

Declared by `src/components/PluginUiProvider.tsx` as `usePluginTranslation`.

```ts
function usePluginTranslation(): PluginTranslate;
```


### `./components` — `usePluginUiFocusTarget` (value)

Declared by `src/components/Focus.tsx` as `usePluginUiFocusTarget`.

```ts
function usePluginUiFocusTarget(): PluginUiFocusTarget;
```


### `./components` — `useSurfaceContext` (value)

Declared by `src/components/PluginUiProvider.tsx` as `useSurfaceContext`.

```ts
function useSurfaceContext(): SurfaceContext;
```


### `./components` — `useTabPanelActivity` (value)

Declared by `src/components/Tabs.tsx` as `useTabPanelActivity`.

```ts
function useTabPanelActivity(): TabPanelActivity;
```


### `./data` — `PluginUiAccountCollectionForDefinition` (type)

Declared by `src/data/types.ts` as `PluginUiAccountCollectionForDefinition`.

```ts
type PluginUiAccountCollectionForDefinition<TDefinition extends PluginAccountCollectionDefinition> = Pick<PluginAccountCollectionForDefinition<TDefinition>, 'get' | 'put' | 'delete' | 'query' | 'batch' | 'limits' | 'measureBatch'>;
```


### `./data` — `PluginUiCollectionQueryFailure` (type)

Declared by `src/data/index.ts` as `PluginUiCollectionQueryFailure`.

```ts
type PluginUiCollectionQueryFailure = PluginCollectionUiQueryErrorV1 | Error;
```


### `./data` — `PluginUiCollectionQueryInput` (type)

Declared by `src/data/types.ts` as `PluginUiCollectionQueryInput`.

```ts
type PluginUiCollectionQueryInput = Readonly<{
    collectionId: PluginCollectionUiQueryRequestV1['collectionId'];
    uiQueryId: PluginCollectionUiQueryRequestV1['uiQueryId'];
    parameters: PluginCollectionUiQueryRequestV1['parameters'];
    signal?: AbortSignal;
}>;
```


### `./data` — `PluginUiCollectionQueryPager` (type)

Declared by `src/data/types.ts` as `PluginUiCollectionQueryPager`.

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

Declared by `src/data/index.ts` as `PluginUiCollectionQueryResult`.

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

Declared by `src/data/types.ts` as `PluginUiCollectionQuerySnapshot`.

```ts
type PluginUiCollectionQuerySnapshot = Readonly<{
    rows: readonly PluginCollectionUiQueryResultV1['rows'][number][];
    hasMore: boolean;
    status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
    error?: PluginCollectionUiQueryErrorV1;
}>;
```


### `./data` — `PluginUiDataClient` (type)

Declared by `src/data/types.ts` as `PluginUiDataClient`.

```ts
type PluginUiDataClient = Readonly<{
    collection<TDefinition extends PluginAccountCollectionDefinition>(definition: TDefinition): PluginUiAccountCollectionForDefinition<TDefinition>;
    openCollectionQuery(input: PluginUiCollectionQueryInput): Promise<PluginUiCollectionQueryPager>;
}>;
```


### `./data` — `usePluginCollectionQuery` (value)

Declared by `src/data/index.ts` as `usePluginCollectionQuery`.

```ts
function usePluginCollectionQuery(collectionId: PluginCollectionUiQueryRequestV1['collectionId'], uiQueryId: PluginCollectionUiQueryRequestV1['uiQueryId'], parameters: PluginCollectionUiQueryRequestV1['parameters'] = {}): PluginUiCollectionQueryResult;
```


### `./data` — `usePluginUiDataClient` (value)

Declared by `src/data/context.ts` as `usePluginUiDataClient`.

```ts
function usePluginUiDataClient(): PluginUiDataClient;
```


### `./environment` — `HAPPIER_ANDROID_MINIMUM_INTERACTIVE_TARGET_SIZE` (value)

Declared by `src/environment/interactiveTarget.ts` as `HAPPIER_ANDROID_MINIMUM_INTERACTIVE_TARGET_SIZE`.

```ts
const HAPPIER_ANDROID_MINIMUM_INTERACTIVE_TARGET_SIZE: 48;
```


### `./environment` — `HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE` (value)

Declared by `src/environment/interactiveTarget.ts` as `HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE`.

```ts
const HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE: 44;
```


### `./environment` — `HappierUiAccessibility` (type)

Declared by `src/environment/types.ts` as `HappierUiAccessibility`.

```ts
type HappierUiAccessibility = Readonly<{
    textScale: number;
    reducedMotion: boolean;
    screenReaderEnabled: boolean;
    contrast: 'normal' | 'high';
}>;
```


### `./environment` — `HappierUiEdgeInsets` (type)

Declared by `src/environment/types.ts` as `HappierUiEdgeInsets`.

```ts
type HappierUiEdgeInsets = Readonly<{
    top: number;
    right: number;
    bottom: number;
    left: number;
}>;
```


### `./environment` — `HappierUiEnvironment` (type)

Declared by `src/environment/types.ts` as `HappierUiEnvironment`.

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

Declared by `src/environment/context.tsx` as `HappierUiEnvironmentProvider`.

```ts
function HappierUiEnvironmentProvider({ environment, children, }: HappierUiEnvironmentProviderProps);
```


### `./environment` — `HappierUiEnvironmentProviderProps` (type)

Declared by `src/environment/context.tsx` as `HappierUiEnvironmentProviderProps`.

```ts
type HappierUiEnvironmentProviderProps = Readonly<{
    environment: HappierUiEnvironment;
    children?: ReactNode;
}>;
```


### `./environment` — `HappierUiInsets` (type)

Declared by `src/environment/types.ts` as `HappierUiInsets`.

```ts
type HappierUiInsets = Readonly<{
    safeArea: HappierUiEdgeInsets;
}>;
```


### `./environment` — `HappierUiLocalization` (type)

Declared by `src/environment/types.ts` as `HappierUiLocalization`.

```ts
type HappierUiLocalization = Readonly<{
    locale: string;
    direction: HappierUiTextDirection;
    translate: (key: string, fallback?: string) => string;
}>;
```


### `./environment` — `HappierUiPlatformFacts` (type)

Declared by `src/environment/types.ts` as `HappierUiPlatformFacts`.

```ts
type HappierUiPlatformFacts = Readonly<{
    platform: PluginUiPlatform;
    colorScheme: 'light' | 'dark';
}>;
```


### `./environment` — `HappierUiPlatformProvider` (value)

Declared by `src/environment/context.tsx` as `HappierUiPlatformProvider`.

```ts
function HappierUiPlatformProvider({ platform, children, }: HappierUiPlatformProviderProps);
```


### `./environment` — `HappierUiPlatformProviderProps` (type)

Declared by `src/environment/context.tsx` as `HappierUiPlatformProviderProps`.

```ts
type HappierUiPlatformProviderProps = Readonly<{
    platform: HappierUiPlatformFacts;
    children?: ReactNode;
}>;
```


### `./environment` — `HappierUiTextDirection` (type)

Declared by `src/environment/types.ts` as `HappierUiTextDirection`.

```ts
type HappierUiTextDirection = 'ltr' | 'rtl';
```


### `./environment` — `HappierUiTheme` (type)

Declared by `src/environment/types.ts` as `HappierUiTheme`.

```ts
type HappierUiTheme = PluginUiThemeV1;
```


### `./environment` — `resolveHappierMinimumInteractiveTargetSize` (value)

Declared by `src/environment/interactiveTarget.ts` as `resolveHappierMinimumInteractiveTargetSize`.

```ts
function resolveHappierMinimumInteractiveTargetSize(platform: string): 44 | 48;
```


### `./environment` — `resolveHappierUiPresentationTheme` (value)

Declared by `src/environment/context.tsx` as `resolveHappierUiPresentationTheme`.

```ts
function resolveHappierUiPresentationTheme(theme: PluginUiThemeV1, contrast: HappierUiAccessibility['contrast']): PluginUiThemeV1;
```


### `./environment` — `useHappierNativeMinimumInteractiveTargetSize` (value)

Declared by `src/environment/interactiveTarget.ts` as `useHappierNativeMinimumInteractiveTargetSize`.

```ts
function useHappierNativeMinimumInteractiveTargetSize(): 44 | 48 | undefined;
```


### `./environment` — `useHappierUiAccessibility` (value)

Declared by `src/environment/context.tsx` as `useHappierUiAccessibility`.

```ts
function useHappierUiAccessibility(): HappierUiAccessibility;
```


### `./environment` — `useHappierUiInsets` (value)

Declared by `src/environment/context.tsx` as `useHappierUiInsets`.

```ts
function useHappierUiInsets(): HappierUiInsets;
```


### `./environment` — `useHappierUiLocalization` (value)

Declared by `src/environment/context.tsx` as `useHappierUiLocalization`.

```ts
function useHappierUiLocalization(): HappierUiLocalization;
```


### `./environment` — `useHappierUiPlatform` (value)

Declared by `src/environment/context.tsx` as `useHappierUiPlatform`.

```ts
function useHappierUiPlatform(): HappierUiPlatformFacts;
```


### `./environment` — `useHappierUiTheme` (value)

Declared by `src/environment/context.tsx` as `useHappierUiTheme`.

```ts
function useHappierUiTheme(): PluginUiThemeV1;
```


### `./environment` — `useOptionalHappierUiAccessibility` (value)

Declared by `src/environment/context.tsx` as `useOptionalHappierUiAccessibility`.

```ts
function useOptionalHappierUiAccessibility(): HappierUiAccessibility | null;
```


### `./environment` — `useOptionalHappierUiLocalization` (value)

Declared by `src/environment/context.tsx` as `useOptionalHappierUiLocalization`.

```ts
function useOptionalHappierUiLocalization(): HappierUiLocalization | null;
```


### `./environment` — `useOptionalHappierUiPlatform` (value)

Declared by `src/environment/context.tsx` as `useOptionalHappierUiPlatform`.

```ts
function useOptionalHappierUiPlatform(): HappierUiPlatformFacts | null;
```


### `./environment` — `useOptionalHappierUiTheme` (value)

Declared by `src/environment/context.tsx` as `useOptionalHappierUiTheme`.

```ts
function useOptionalHappierUiTheme(): PluginUiThemeV1 | null;
```


### `./hostApi` — `ComposerContentHandleV1` (type)

Declared by `src/composer/types.ts` as `ComposerContentHandleV1`.

```ts
type ComposerContentHandleV1 = Awaited<ReturnType<PluginUiHostApi['pickComposerMedia']>>;
```


### `./hostApi` — `ComposerContentInspectRequestV1` (type)

Declared by `src/composer/types.ts` as `ComposerContentInspectRequestV1`.

```ts
type ComposerContentInspectRequestV1 = Parameters<PluginUiHostApi['inspectComposerContent']>[1];
```


### `./hostApi` — `ComposerContentInspectResultV1` (type)

Declared by `src/composer/types.ts` as `ComposerContentInspectResultV1`.

```ts
type ComposerContentInspectResultV1 = Awaited<ReturnType<PluginUiHostApi['inspectComposerContent']>>;
```


### `./hostApi` — `ComposerContentPickMediaRequestV1` (type)

Declared by `src/composer/types.ts` as `ComposerContentPickMediaRequestV1`.

```ts
type ComposerContentPickMediaRequestV1 = Parameters<PluginUiHostApi['pickComposerMedia']>[1];
```


### `./hostApi` — `ComposerContentService` (type)

Declared by `src/composer/service.ts` as `ComposerContentService`.

```ts
interface ComposerContentService {
    pickMedia(request: ComposerContentPickMediaRequestV1, options?: ComposerRequestOptions): Promise<ComposerContentHandleV1>;
    inspect(handle: ComposerContentHandleV1, request: ComposerContentInspectRequestV1, options?: ComposerRequestOptions): Promise<ComposerContentInspectResultV1>;
    release(handle: ComposerContentHandleV1, options?: ComposerRequestOptions): Promise<void>;
}
```


### `./hostApi` — `ComposerDecorationResultV1` (type)

Declared by `src/composer/types.ts` as `ComposerDecorationResultV1`.

```ts
type ComposerDecorationResultV1 = Awaited<ReturnType<PluginUiHostApi['setComposerDecorations']>>;
```


### `./hostApi` — `ComposerDecorationSetV1` (type)

Declared by `src/composer/types.ts` as `ComposerDecorationSetV1`.

```ts
type ComposerDecorationSetV1 = SdkComposerDecorationSetV1;
```


### `./hostApi` — `ComposerFocusResultV1` (type)

Declared by `src/composer/types.ts` as `ComposerFocusResultV1`.

```ts
type ComposerFocusResultV1 = Awaited<ReturnType<PluginUiHostApi['focusComposer']>>;
```


### `./hostApi` — `ComposerHandle` (type)

Declared by `src/composer/service.ts` as `ComposerHandle`.

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

Declared by `src/composer/types.ts` as `ComposerInputLockRequestV1`.

```ts
type ComposerInputLockRequestV1 = Parameters<PluginUiHostApi['acquireComposerInputLock']>[1];
```


### `./hostApi` — `ComposerObserverV1` (type)

Declared by `src/composer/types.ts` as `ComposerObserverV1`.

```ts
type ComposerObserverV1 = Parameters<PluginUiHostApi['watchComposer']>[1];
```


### `./hostApi` — `ComposerReadResultV1` (type)

Declared by `src/composer/types.ts` as `ComposerReadResultV1`.

```ts
type ComposerReadResultV1 = Awaited<ReturnType<PluginUiHostApi['readComposer']>>;
```


### `./hostApi` — `ComposerRefV1` (type)

Declared by `src/composer/types.ts` as `ComposerRefV1`.

```ts
type ComposerRefV1 = Parameters<PluginUiHostApi['readComposer']>[0];
```


### `./hostApi` — `ComposerRequestOptions` (type)

Declared by `src/composer/types.ts` as `ComposerRequestOptions`.

```ts
type ComposerRequestOptions = Parameters<PluginUiHostApi['readComposer']>[1];
```


### `./hostApi` — `ComposerSnapshotV1` (type)

Declared by `src/composer/types.ts` as `ComposerSnapshotV1`.

```ts
type ComposerSnapshotV1 = Extract<ComposerReadResultV1, Readonly<{
    status: 'ready';
}>>['snapshot'];
```


### `./hostApi` — `ComposerTransactionResultV1` (type)

Declared by `src/composer/types.ts` as `ComposerTransactionResultV1`.

```ts
type ComposerTransactionResultV1 = Awaited<ReturnType<PluginUiHostApi['applyComposer']>>;
```


### `./hostApi` — `ComposerTransactionV1` (type)

Declared by `src/composer/types.ts` as `ComposerTransactionV1`.

```ts
type ComposerTransactionV1 = Parameters<PluginUiHostApi['applyComposer']>[1];
```


### `./hostApi` — `ComposerViewStateV1` (type)

Declared by `src/composer/hooks.ts` as `ComposerViewStateV1`.

```ts
type ComposerViewStateV1 = Readonly<{
    result: ComposerReadResultV1 | null;
    error: PluginError | null;
    pending: 'initial' | 'refresh' | null;
    refresh(): Promise<void>;
}>;
```


### `./hostApi` — `ComposersService` (type)

Declared by `src/composer/service.ts` as `ComposersService`.

```ts
interface ComposersService {
    current(): ComposerHandle | null;
    active(options?: ComposerRequestOptions): Promise<ComposerHandle | null>;
    get(ref: ComposerRefV1, options?: ComposerRequestOptions): Promise<ComposerHandle | null>;
}
```


### `./hostApi` — `PluginActionExecution` (type)

Declared by `src/hostApi/executeAction.ts` as `PluginActionExecution`.

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

Declared by `src/hostApi/executeAction.ts` as `PluginActionExecutionController`.

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


### `./hostApi` — `PluginUiHostApi` (type)

Re-exported from another package as `PluginUiHostApi`; that package owns the declaration.

```ts
// declared by another package — see its own declaration report
```


### `./hostApi` — `PluginUiResourceError` (type)

Declared by `src/hostApi/resourceStore.ts` as `PluginUiResourceError`.

```ts
type PluginUiResourceError = Readonly<{
    code?: string;
    diagnostics?: readonly string[];
    message: string;
}>;
```


### `./hostApi` — `PluginUiResourceReference` (type)

Declared by `src/hostApi/resourceStore.ts` as `PluginUiResourceReference`.

```ts
type PluginUiResourceReference = Parameters<PluginUiHostApi['readResource']>[0];
```


### `./hostApi` — `PluginUiResourceResult` (type)

Declared by `src/hostApi/index.ts` as `PluginUiResourceResult`.

```ts
type PluginUiResourceResult = Readonly<{
    resource: PluginUiResourceSnapshot;
    refresh: () => void;
}>;
```


### `./hostApi` — `PluginUiResourceSnapshot` (type)

Declared by `src/hostApi/resourceStore.ts` as `PluginUiResourceSnapshot`.

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


### `./hostApi` — `useComposer` (value)

Declared by `src/composer/hooks.ts` as `useComposer`.

```ts
function useComposer(): ComposersService;
```


### `./hostApi` — `useComposerView` (value)

Declared by `src/composer/hooks.ts` as `useComposerView`.

```ts
function useComposerView(handle: ComposerHandle | null): ComposerViewStateV1;
```


### `./hostApi` — `useExecutePluginAction` (value)

Declared by `src/hostApi/executeAction.ts` as `useExecutePluginAction`.

```ts
function useExecutePluginAction<TAction extends PluginUiActionReference>(action: TAction, input?: NoInfer<PluginUiActionInputFor<NoInfer<TAction>>>): PluginActionExecutionController<PluginUiActionResultFor<NoInfer<TAction>>, PluginUiActionInputFor<NoInfer<TAction>>>;
function useExecutePluginAction(action: PluginUiActionReference, input?: JsonValue): PluginActionExecutionController<JsonValue, JsonValue>;
```


### `./hostApi` — `useLivePluginResource` (value)

Declared by `src/hostApi/index.ts` as `useLivePluginResource`.

```ts
function useLivePluginResource(resource: PluginUiResourceReference): PluginUiResourceResult;
```


### `./hostApi` — `usePluginHostApi` (value)

Declared by `src/hostApi/context.ts` as `usePluginHostApi`.

```ts
function usePluginHostApi(): PluginUiHostApi;
```


### `./hostApi` — `usePluginResource` (value)

Declared by `src/hostApi/index.ts` as `usePluginResource`.

```ts
function usePluginResource(resource: PluginUiResourceReference): PluginUiResourceResult;
```


### `./presentation` — `HAPPIER_ICON_NAMES` (value)

Declared by `src/presentation/content/Icon.ts` as `HAPPIER_ICON_NAMES`.

```ts
const HAPPIER_ICON_NAMES: readonly PluginUiIconTokenV1[];
```


### `./presentation` — `HAPPIER_TONE_COLOR_TOKEN` (value)

Declared by `src/presentation/semantics.ts` as `HAPPIER_TONE_COLOR_TOKEN`.

```ts
const HAPPIER_TONE_COLOR_TOKEN: { readonly neutral: "text"; readonly secondary: "secondaryText"; readonly muted: "mutedText"; readonly info: "info"; readonly success: "success"; readonly warning: "warning"; readonly danger: "danger"; readonly accent: "accent"; };
```


### `./presentation` — `HappierActionFieldPresentation` (type)

Declared by `src/presentation/form/actionInputFields.ts` as `HappierActionFieldPresentation`.

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

Declared by `src/presentation/interaction/ActionPanel.tsx` as `HappierActionPanel`.

```ts
function HappierActionPanel({ title, children, testID, style }: HappierActionPanelProps);
```


### `./presentation` — `HappierActionPanelProps` (type)

Declared by `src/presentation/interaction/ActionPanel.tsx` as `HappierActionPanelProps`.

```ts
type HappierActionPanelProps = Readonly<{
    title?: string;
    children?: ReactNode;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `./presentation` — `HappierActionPanelSection` (value)

Declared by `src/presentation/interaction/ActionPanel.tsx` as `HappierActionPanelSection`.

```ts
function HappierActionPanelSection({ title, children, testID, style }: HappierActionPanelSectionProps);
```


### `./presentation` — `HappierActionPanelSectionProps` (type)

Declared by `src/presentation/interaction/ActionPanel.tsx` as `HappierActionPanelSectionProps`.

```ts
type HappierActionPanelSectionProps = Readonly<{
    title?: string;
    children?: ReactNode;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `./presentation` — `HappierBadge` (value)

Declared by `src/presentation/content/Foundation.tsx` as `HappierBadge`.

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
}>);
```


### `./presentation` — `HappierBanner` (value)

Declared by `src/presentation/content/Foundation.tsx` as `HappierBanner`.

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
}>);
```


### `./presentation` — `HappierBrandMark` (value)

Declared by `src/presentation/content/Image.tsx` as `HappierBrandMark`.

```ts
function HappierBrandMark(props: HappierBrandMarkProps): ReactElement;
```


### `./presentation` — `HappierBrandMarkProps` (type)

Declared by `src/presentation/content/Image.tsx` as `HappierBrandMarkProps`.

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
}>;
```


### `./presentation` — `HappierCodeBlockBehaviorInput` (type)

Declared by `src/presentation/content/CodeBlock.ts` as `HappierCodeBlockBehaviorInput`.

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


### `./presentation` — `HappierDivider` (value)

Declared by `src/presentation/content/Foundation.tsx` as `HappierDivider`.

```ts
function HappierDivider(props: Readonly<{
    color: string;
    accessibilityLabel?: string;
    testID?: string;
    style?: HappierStyleProp;
}>);
```


### `./presentation` — `HappierField` (value)

Declared by `src/presentation/form/Fields.tsx` as `HappierField`.

```ts
function HappierField(props: HappierFieldProps);
```


### `./presentation` — `HappierFieldProps` (type)

Declared by `src/presentation/form/Fields.tsx` as `HappierFieldProps`.

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

Declared by `src/presentation/form/Fields.tsx` as `HappierForm`.

```ts
function HappierForm({ children, accessibilityLabel, busy, testID, style }: HappierFormProps);
```


### `./presentation` — `HappierFormActions` (value)

Declared by `src/presentation/form/Fields.tsx` as `HappierFormActions`.

```ts
function HappierFormActions({ children, testID, style }: HappierFormActionsProps);
```


### `./presentation` — `HappierFormActionsProps` (type)

Declared by `src/presentation/form/Fields.tsx` as `HappierFormActionsProps`.

```ts
type HappierFormActionsProps = Readonly<{
    children?: ReactNode;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `./presentation` — `HappierFormPendingInput` (type)

Declared by `src/presentation/form/Fields.tsx` as `HappierFormPendingInput`.

```ts
type HappierFormPendingInput = Readonly<{
    busy?: boolean;
    implicitPending?: boolean;
}>;
```


### `./presentation` — `HappierFormProps` (type)

Declared by `src/presentation/form/Fields.tsx` as `HappierFormProps`.

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

Declared by `src/presentation/content/Foundation.tsx` as `HappierHeading`.

```ts
function HappierHeading(props: Readonly<{
    children?: ReactNode;
    controlRef?: (instance: unknown | null) => void;
    level: 1 | 2 | 3 | 4 | 5 | 6;
    theme?: HappierUiTheme;
    testID?: string;
}>);
```


### `./presentation` — `HappierIconName` (type)

Declared by `src/presentation/content/Icon.ts` as `HappierIconName`.

```ts
type HappierIconName = PluginUiIconTokenV1;
```


### `./presentation` — `HappierIconSize` (type)

Declared by `src/presentation/content/Icon.ts` as `HappierIconSize`.

```ts
type HappierIconSize = 'small' | 'medium' | 'large';
```


### `./presentation` — `HappierImageSize` (type)

Declared by `src/presentation/content/Image.tsx` as `HappierImageSize`.

```ts
type HappierImageSize = 'small' | 'medium' | 'large';
```


### `./presentation` — `HappierInfoState` (value)

Declared by `src/presentation/state/InfoState.tsx` as `HappierInfoState`.

```ts
function HappierInfoState({ children, action, testID, actionTestID, accessibilityRole, accessibilityLiveRegion, busy, }: HappierInfoStateProps);
```


### `./presentation` — `HappierInfoStateProps` (type)

Declared by `src/presentation/state/InfoState.tsx` as `HappierInfoStateProps`.

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

Declared by `src/presentation/state/InfoState.tsx` as `HappierInfoTile`.

```ts
function HappierInfoTile({ icon, title, description, tone, paddingHorizontal, }: HappierInfoTileProps);
```


### `./presentation` — `HappierInfoTileProps` (type)

Declared by `src/presentation/state/InfoState.tsx` as `HappierInfoTileProps`.

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

Declared by `src/presentation/collection/semantics.ts` as `HappierItemBehavior`.

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

Declared by `src/presentation/collection/semantics.ts` as `HappierItemBehaviorInput`.

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

Declared by `src/presentation/collection/semantics.ts` as `HappierItemDensity`.

```ts
type HappierItemDensity = 'comfortable' | 'cozy' | 'compact' | 'tight';
```


### `./presentation` — `HappierItemGroup` (value)

Declared by `src/presentation/collection/ItemGroup.tsx` as `HappierItemGroup`.

```ts
function HappierItemGroup(props: HappierItemGroupProps);
```


### `./presentation` — `HappierItemGroupBehavior` (value)

Declared by `src/presentation/collection/ItemGroup.tsx` as `HappierItemGroupBehavior`.

```ts
function HappierItemGroupBehavior(props: HappierItemGroupBehaviorProps);
```


### `./presentation` — `HappierItemGroupBehaviorProps` (type)

Declared by `src/presentation/collection/ItemGroup.tsx` as `HappierItemGroupBehaviorProps`.

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

Declared by `src/presentation/collection/ItemGroup.tsx` as `HappierItemGroupItemBehaviorInput`.

```ts
type HappierItemGroupItemBehaviorInput = Readonly<{
    role?: 'radio' | 'option' | 'button';
    itemGroupRadioIndex?: number;
    disabled?: boolean;
    busy?: boolean;
}>;
```


### `./presentation` — `HappierItemGroupProps` (type)

Declared by `src/presentation/collection/ItemGroup.tsx` as `HappierItemGroupProps`.

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

Declared by `src/presentation/collection/ItemGroup.tsx` as `HappierItemGroupRadioFocusable`.

```ts
type HappierItemGroupRadioFocusable = HappierFocusable;
```


### `./presentation` — `HappierItemGroupSelectionContext` (value)

Declared by `src/presentation/collection/ItemGroup.tsx` as `HappierItemGroupSelectionContext`.

```ts
const HappierItemGroupSelectionContext: React.Context<Readonly<{ selectableItemCount: number; radioGroup?: HappierItemGroupRadioContext | null; }> | null>;
```


### `./presentation` — `HappierItemOverflow` (value)

Declared by `src/presentation/collection/ItemOverflow.tsx` as `HappierItemOverflow`.

```ts
function HappierItemOverflow(props: HappierItemOverflowProps): ReactElement | null;
```


### `./presentation` — `HappierItemOverflowAction` (type)

Declared by `src/presentation/collection/ItemOverflow.tsx` as `HappierItemOverflowAction`.

```ts
type HappierItemOverflowAction = Readonly<{
    id: string;
    label: string;
    disabled?: boolean;
    icon?: ReactNode;
}>;
```


### `./presentation` — `HappierItemOverflowProps` (type)

Declared by `src/presentation/collection/ItemOverflow.tsx` as `HappierItemOverflowProps`.

```ts
type HappierItemOverflowProps = Readonly<{
    actions: readonly HappierItemOverflowAction[];
    secondaryActionsEnabled?: boolean;
    accessibilityLabel: string;
    onSelect(id: string): void;
    renderMenu(input: HappierItemOverflowRenderInput): ReactElement;
    testID?: string;
}>;
```


### `./presentation` — `HappierItemOverflowRenderInput` (type)

Declared by `src/presentation/collection/ItemOverflow.tsx` as `HappierItemOverflowRenderInput`.

```ts
type HappierItemOverflowRenderInput = Readonly<{
    open: boolean;
    onOpenChange(open: boolean): void;
    trigger: string;
    triggerAccessibilityLabel: string;
    testID?: string;
    disabled: boolean;
    actions: readonly HappierItemOverflowAction[];
    onSelect(id: string): void;
}>;
```


### `./presentation` — `HappierItemSemanticInput` (type)

Declared by `src/presentation/collection/semantics.ts` as `HappierItemSemanticInput`.

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

Declared by `src/presentation/collection/semantics.ts` as `HappierItemSemanticState`.

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

Declared by `src/presentation/content/Foundation.tsx` as `HappierLabel`.

```ts
function HappierLabel(props: Readonly<{
    children?: ReactNode;
    theme?: HappierUiTheme;
    testID?: string;
}>);
```


### `./presentation` — `HappierLayoutGap` (type)

Declared by `src/presentation/layout/Layout.tsx` as `HappierLayoutGap`.

```ts
type HappierLayoutGap = 'none' | 'xsmall' | 'small' | 'medium' | 'large' | 'xlarge';
```


### `./presentation` — `HappierLink` (value)

Declared by `src/presentation/content/Foundation.tsx` as `HappierLink`.

```ts
function HappierLink(props: Readonly<{
    children?: ReactNode;
    label: string;
    disabled?: boolean;
    onPress: () => unknown;
    theme: HappierUiTheme;
    testID?: string;
}>);
```


### `./presentation` — `HappierList` (value)

Declared by `src/presentation/collection/List.tsx` as `HappierList`.

```ts
function HappierList({ children, accessibilityLabel, testID, style, }: HappierListProps);
```


### `./presentation` — `HappierListItem` (value)

Declared by `src/presentation/collection/List.tsx` as `HappierListItem`.

```ts
function HappierListItem({ children, title, subtitle, detail, icon, accessory, accessoryOutsidePressable, tone = 'neutral', onPress, disabled, busy, selected, accessibilityRole, accessibilityExpanded, accessibilityPositionInSet, accessibilitySetSize, theme, minimumTouchTarget, density, showDivider, hasSecondaryActions, accessibilityLabel, testID, style, itemGroupRadioIndex, rovingCollectionItem, suppressListItemRole, }: HappierListItemProps);
```


### `./presentation` — `HappierListItemProps` (type)

Declared by `src/presentation/collection/List.tsx` as `HappierListItemProps`.

```ts
type HappierListItemProps = Readonly<{
    children?: ReactNode;
    title?: string;
    subtitle?: string;
    detail?: string;
    icon?: ReactNode;
    accessory?: ReactNode;
    accessoryOutsidePressable?: boolean;
    tone?: HappierTone;
    onPress?: () => unknown;
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
    testID?: string;
    style?: HappierStyleProp;
    itemGroupRadioIndex?: number;
    rovingCollectionItem?: HappierRovingCollectionItem;
    suppressListItemRole?: boolean;
}>;
```


### `./presentation` — `HappierListProps` (type)

Declared by `src/presentation/collection/List.tsx` as `HappierListProps`.

```ts
type HappierListProps = Readonly<{
    children?: ReactNode;
    accessibilityLabel?: string;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `./presentation` — `HappierListSection` (value)

Declared by `src/presentation/collection/List.tsx` as `HappierListSection`.

```ts
function HappierListSection({ children, title, virtualizedCollectionRole, testID, style, }: HappierListSectionProps);
```


### `./presentation` — `HappierListSectionProps` (type)

Declared by `src/presentation/collection/List.tsx` as `HappierListSectionProps`.

```ts
type HappierListSectionProps = Readonly<{
    children?: ReactNode;
    title: string;
    virtualizedCollectionRole?: 'list' | 'listbox';
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `./presentation` — `HappierMarkdown` (value)

Declared by `src/presentation/content/Markdown.tsx` as `HappierMarkdown`.

```ts
function HappierMarkdown(input: HappierMarkdownProps): ReactElement;
```


### `./presentation` — `HappierMarkdownProps` (type)

Declared by `src/presentation/content/Markdown.tsx` as `HappierMarkdownProps`.

```ts
type HappierMarkdownProps = HappierMarkdownRenderInput & Readonly<{
    renderContent?: (input: HappierMarkdownRenderInput) => ReactElement;
}>;
```


### `./presentation` — `HappierMarkdownRenderInput` (type)

Declared by `src/presentation/content/Markdown.tsx` as `HappierMarkdownRenderInput`.

```ts
type HappierMarkdownRenderInput = Readonly<{
    value: string;
    selectable: boolean;
    testID?: string;
}>;
```


### `./presentation` — `HappierMenuContent` (type)

Declared by `src/presentation/interaction/Menu.ts` as `HappierMenuContent`.

```ts
type HappierMenuContent<Item extends HappierMenuItemDescriptor = HappierMenuItemDescriptor> = Readonly<{
    items: readonly Item[];
    ungroupedEntries: readonly HappierMenuEntry<Item>[];
    groups: readonly HappierResolvedMenuGroup<Item>[];
}>;
```


### `./presentation` — `HappierMenuEntry` (type)

Declared by `src/presentation/interaction/Menu.ts` as `HappierMenuEntry`.

```ts
type HappierMenuEntry<Item extends HappierMenuItemDescriptor = HappierMenuItemDescriptor> = Readonly<{
    item: Item;
    index: number;
}>;
```


### `./presentation` — `HappierMenuGroupDescriptor` (type)

Declared by `src/presentation/interaction/Menu.ts` as `HappierMenuGroupDescriptor`.

```ts
type HappierMenuGroupDescriptor<Item extends HappierMenuItemDescriptor = HappierMenuItemDescriptor> = Readonly<{
    id: string;
    accessibilityLabel: string;
    items: readonly Item[];
}>;
```


### `./presentation` — `HappierMenuInteractionInput` (type)

Declared by `src/presentation/interaction/Menu.ts` as `HappierMenuInteractionInput`.

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

Declared by `src/presentation/interaction/Menu.ts` as `HappierMenuItemDescriptor`.

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

Declared by `src/presentation/interaction/Menu.ts` as `HappierMenuKeyAction`.

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

Declared by `src/presentation/interaction/Menu.ts` as `HappierMenuRadioGroupDescriptor`.

```ts
type HappierMenuRadioGroupDescriptor = Readonly<{
    id: string;
    accessibilityLabel: string;
    selectedId: string | null;
}>;
```


### `./presentation` — `HappierMetadata` (value)

Declared by `src/presentation/content/Foundation.tsx` as `HappierMetadata`.

```ts
function HappierMetadata(props: Readonly<{
    title?: string;
    entries: readonly HappierMetadataEntry[];
    theme: HappierUiTheme;
    testID?: string;
}>);
```


### `./presentation` — `HappierMetadataEntry` (type)

Declared by `src/presentation/content/Foundation.tsx` as `HappierMetadataEntry`.

```ts
type HappierMetadataEntry = Readonly<{
    label: string;
    value: string;
    tone?: HappierTone;
    accessibilityLabel?: string;
    testID?: string;
}>;
```


### `./presentation` — `HappierPopoverPlacement` (type)

Declared by `src/presentation/interaction/Menu.ts` as `HappierPopoverPlacement`.

```ts
type HappierPopoverPlacement = HappierResolvedPopoverPlacement | 'auto' | 'auto-vertical' | 'auto-horizontal';
```


### `./presentation` — `HappierPressable` (value)

Declared by `src/presentation/interaction/Pressable.tsx` as `HappierPressable`.

```ts
function HappierPressable({ onPress, onPressIn, onLongPress, onContextMenu, onKeyDown, onFocusChange, disabled, busy, invalid, errorMessageId, highlighted, selected, expanded, accessibilityPositionInSet, accessibilitySetSize, hasPopup, checked, accessibilityRole = 'button', webRole, accessibilityLabel, accessibilityHint, hitSlop, testID, controlRef, tabIndex, nativeID, controls, style, overlay, children, }: HappierPressableProps);
```


### `./presentation` — `HappierPressableProps` (type)

Declared by `src/presentation/interaction/Pressable.tsx` as `HappierPressableProps`.

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

Declared by `src/presentation/interaction/Pressable.tsx` as `HappierPressableRole`.

```ts
type HappierPressableRole = 'button' | 'checkbox' | 'link' | 'radio' | 'tab' | 'switch' | 'menuitem' | 'menuitemcheckbox' | 'menuitemradio' | 'option';
```


### `./presentation` — `HappierPressableState` (type)

Declared by `src/presentation/interaction/Pressable.tsx` as `HappierPressableState`.

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

Declared by `src/presentation/interaction/Pressable.tsx` as `HappierPressableStyleState`.

```ts
type HappierPressableStyleState = HappierPressableState & Readonly<{
    pressed: boolean;
}>;
```


### `./presentation` — `HappierProgress` (value)

Declared by `src/presentation/content/Foundation.tsx` as `HappierProgress`.

```ts
function HappierProgress(props: Readonly<{
    value?: number;
    label: string;
    theme: HappierUiTheme;
    testID?: string;
    style?: HappierStyleProp;
    pointerEvents?: 'auto' | 'box-none' | 'box-only' | 'none';
    renderFill?: (percentage: number) => ReactNode;
}>);
```


### `./presentation` — `HappierResolvedMenuGroup` (type)

Declared by `src/presentation/interaction/Menu.ts` as `HappierResolvedMenuGroup`.

```ts
type HappierResolvedMenuGroup<Item extends HappierMenuItemDescriptor = HappierMenuItemDescriptor> = Readonly<{
    id: string;
    accessibilityLabel: string;
    entries: readonly HappierMenuEntry<Item>[];
}>;
```


### `./presentation` — `HappierResolvedPopoverPlacement` (type)

Declared by `src/presentation/interaction/Menu.ts` as `HappierResolvedPopoverPlacement`.

```ts
type HappierResolvedPopoverPlacement = 'top' | 'bottom' | 'left' | 'right';
```


### `./presentation` — `HappierRovingEntry` (type)

Declared by `src/presentation/collection/semantics.ts` as `HappierRovingEntry`.

```ts
type HappierRovingEntry = Readonly<{
    disabled: boolean;
}>;
```


### `./presentation` — `HappierScreen` (value)

Declared by `src/presentation/layout/Layout.tsx` as `HappierScreen`.

```ts
function HappierScreen({ children, controlRef, testID, style, safeAreaInsets }: HappierScreenProps);
```


### `./presentation` — `HappierScreenProps` (type)

Declared by `src/presentation/layout/Layout.tsx` as `HappierScreenProps`.

```ts
type HappierScreenProps = Readonly<{
    children?: ReactNode;
    controlRef?: (instance: unknown | null) => void;
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

Declared by `src/presentation/layout/Layout.tsx` as `HappierScrollArea`.

```ts
function HappierScrollArea({ children, accessibilityLabel, testID, style, contentContainerStyle, safeAreaInsets, keyboardShouldPersistTaps = 'handled', ...scrollProps }: HappierScrollAreaProps);
```


### `./presentation` — `HappierScrollAreaProps` (type)

Declared by `src/presentation/layout/Layout.tsx` as `HappierScrollAreaProps`.

```ts
type HappierScrollAreaProps = Readonly<{
    children?: ReactNode;
    horizontal?: boolean;
    keyboardShouldPersistTaps?: HappierKeyboardShouldPersistTaps;
    onScroll?: (event: HappierScrollEvent) => void;
    scrollEventThrottle?: number;
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

Declared by `src/presentation/form/Fields.tsx` as `HappierSelect`.

```ts
function HappierSelect<Value = string>(props: Readonly<{
    label: string;
    options: readonly HappierSelectOption<Value>[];
    value: Value | readonly Value[] | undefined;
    multiple?: boolean;
    maxSelections?: number;
    minimumSelections?: number;
    onChange: (value: Value | readonly Value[]) => void;
    isEqual?: (left: Value, right: Value) => boolean;
    keyForOption?: (option: HappierSelectOption<Value>, index: number) => string;
    minimumTouchTarget?: number;
    disabled?: boolean;
    theme: HappierUiTheme;
    testID?: string;
}>);
```


### `./presentation` — `HappierSelectOption` (type)

Declared by `src/presentation/form/Fields.tsx` as `HappierSelectOption`.

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

Declared by `src/presentation/collection/semantics.ts` as `HappierSelectableRole`.

```ts
type HappierSelectableRole = 'radio' | 'option' | 'button' | undefined;
```


### `./presentation` — `HappierSpinner` (value)

Declared by `src/presentation/feedback/Spinner.tsx` as `HappierSpinner`.

```ts
function HappierSpinner(props: HappierSpinnerProps);
```


### `./presentation` — `HappierSpinnerProps` (type)

Declared by `src/presentation/feedback/Spinner.tsx` as `HappierSpinnerProps`.

```ts
type HappierSpinnerProps = HappierActivityIndicatorHostProps & Readonly<{
    size?: HappierActivityIndicatorHostProps['size'];
    animationEnabled?: boolean;
    reducedMotion?: boolean;
}>;
```


### `./presentation` — `HappierStack` (value)

Declared by `src/presentation/layout/Layout.tsx` as `HappierStack`.

```ts
function HappierStack({ children, direction = 'vertical', gap = 0, wrap = false, align, justify, controlRef, testID, style, }: HappierStackProps);
```


### `./presentation` — `HappierStackProps` (type)

Declared by `src/presentation/layout/Layout.tsx` as `HappierStackProps`.

```ts
type HappierStackProps = Readonly<{
    children?: ReactNode;
    controlRef?: (instance: unknown | null) => void;
    direction?: 'vertical' | 'horizontal';
    gap?: number;
    wrap?: boolean;
    align?: HappierAlignment;
    justify?: HappierJustification;
    testID?: string;
    style?: HappierStyleProp;
}>;
```


### `./presentation` — `HappierStatus` (value)

Declared by `src/presentation/status/Status.tsx` as `HappierStatus`.

```ts
function HappierStatus(props: HappierStatusProps);
```


### `./presentation` — `HappierStatusDot` (value)

Declared by `src/presentation/status/StatusDot.tsx` as `HappierStatusDot`.

```ts
function HappierStatusDot(props: HappierStatusDotProps);
```


### `./presentation` — `HappierStatusDotProps` (type)

Declared by `src/presentation/status/StatusDot.tsx` as `HappierStatusDotProps`.

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

Declared by `src/presentation/status/Status.tsx` as `HappierStatusProps`.

```ts
type HappierStatusProps = Readonly<{
    label: ReactNode;
    value?: ReactNode;
    tone: HappierTone;
    theme: HappierUiTheme;
    contrast?: HappierUiAccessibility['contrast'];
    isPulsing?: boolean;
    controlRef?: (instance: unknown | null) => void;
    testID?: string;
    accessibilityLiveRegion?: HappierAccessibilityLiveRegion;
}>;
```


### `./presentation` — `HappierSurface` (value)

Declared by `src/presentation/layout/Surface.tsx` as `HappierSurface`.

```ts
function HappierSurface({ children, testID, onPress, disabled, accessibilityLabel, style, pressableStyle, pressedStyle, }: HappierSurfaceProps);
```


### `./presentation` — `HappierSurfaceProps` (type)

Declared by `src/presentation/layout/Surface.tsx` as `HappierSurfaceProps`.

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

Declared by `src/presentation/navigation/Tabs.tsx` as `HappierTabDescriptor`.

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

Declared by `src/presentation/navigation/Tabs.tsx` as `HappierTabPanelActivity`.

```ts
type HappierTabPanelActivity = Readonly<{
    active: boolean;
    activeSignal: AbortSignal;
}>;
```


### `./presentation` — `HappierTabRetention` (type)

Declared by `src/presentation/navigation/Tabs.tsx` as `HappierTabRetention`.

```ts
type HappierTabRetention = 'retain' | 'discard';
```


### `./presentation` — `HappierTabs` (value)

Declared by `src/presentation/navigation/Tabs.tsx` as `HappierTabs`.

```ts
function HappierTabs(props: Readonly<{
    value: string;
    onValueChange: (value: string) => void;
    ariaLabel: string;
    children?: ReactNode;
    theme: HappierUiTheme;
    testID?: string;
}>);
```


### `./presentation` — `HappierText` (value)

Declared by `src/presentation/text/Text.tsx` as `HappierText`.

```ts
const HappierText: import("/Users/leeroy/Documents/Development/happier/dev/packages/plugin-ui/node_modules/@types/react/index").NamedExoticComponent<Readonly<{ children?: ReactNode; style?: HappierStyleProp; accessible?: boolean; accessibilityLabel?: string; accessibilityHint?: string; accessibilityLiveRegion?: import("/Users/leeroy/Documents/Development/happier/dev/packages/plugin-ui/src/presentation/portableTypes").HappierAccessibilityLiveRegion; accessibilityRole?: "alert" | "header" | "link" | "none" | "text"; allowFontScaling?: boolean; ellipsizeMode?: "clip" | "head" | "middle" | "tail"; maxFontSizeMultiplier?: number | null; nativeID?: string; numberOfLines?: number; onLayout?: (event: import("/Users/leeroy/Documents/Development/happier/dev/packages/plugin-ui/src/presentation/portableTypes").HappierLayoutChangeEvent) => void; onLongPress?: (event?: import("/Users/leeroy/Documents/Development/happier/dev/packages/plugin-ui/src/presentation/portableTypes").HappierGestureResponderEvent) => void; onPress?: (event?: import("/Users/leeroy/Documents/Development/happier/dev/packages/plugin-ui/src/presentation/portableTypes").HappierGestureResponderEvent) => void; selectable?: boolean; suppressHighlighting?: boolean; testID?: string; }> & Readonly<{ variant?: HappierTextVariant; tone?: HappierTone; selectable?: boolean; textScale?: number; scaleStyleEntry?: TextStyleEntryTransform; baseStyle?: HappierStyleProp; tabIndex?: 0 | -1; }> & import("/Users/leeroy/Documents/Development/happier/dev/packages/plugin-ui/node_modules/@types/react/index").RefAttributes<unknown>>;
```


### `./presentation` — `HappierTextField` (value)

Declared by `src/presentation/form/Fields.tsx` as `HappierTextField`.

```ts
function HappierTextField(props: HappierTextFieldProps);
```


### `./presentation` — `HappierTextFieldProps` (type)

Declared by `src/presentation/form/Fields.tsx` as `HappierTextFieldProps`.

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
    minimumTouchTarget?: number;
    controlRef?: (instance: unknown | null) => void;
    theme: HappierUiTheme;
    testID?: string;
}>;
```


### `./presentation` — `HappierTextPresentation` (type)

Declared by `src/presentation/text/Text.tsx` as `HappierTextPresentation`.

```ts
type HappierTextPresentation = Readonly<{
    selectable: boolean;
    metricScale: number;
    allowHostFontScaling: boolean;
}>;
```


### `./presentation` — `HappierTextPresentationInput` (type)

Declared by `src/presentation/text/Text.tsx` as `HappierTextPresentationInput`.

```ts
type HappierTextPresentationInput = Readonly<{
    selectable?: boolean;
    textScale?: number;
}>;
```


### `./presentation` — `HappierTextProps` (type)

Declared by `src/presentation/text/Text.tsx` as `HappierTextProps`.

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

Declared by `src/presentation/text/Text.tsx` as `HappierTextSelectabilityScope`.

```ts
function HappierTextSelectabilityScope({ selectable, children, }: HappierTextSelectabilityScopeProps);
```


### `./presentation` — `HappierTextSelectabilityScopeProps` (type)

Declared by `src/presentation/text/Text.tsx` as `HappierTextSelectabilityScopeProps`.

```ts
type HappierTextSelectabilityScopeProps = Readonly<{
    selectable: boolean;
    children: ReactNode;
}>;
```


### `./presentation` — `HappierTextVariant` (type)

Declared by `src/presentation/semantics.ts` as `HappierTextVariant`.

```ts
type HappierTextVariant = 'body' | 'label' | 'title' | 'caption' | 'code';
```


### `./presentation` — `HappierToggle` (value)

Declared by `src/presentation/form/Fields.tsx` as `HappierToggle`.

```ts
function HappierToggle(props: Readonly<{
    label: string;
    value: boolean;
    onChange: (value: boolean) => void;
    disabled?: boolean;
    minimumTouchTarget?: number;
    theme: HappierUiTheme;
    testID?: string;
}>);
```


### `./presentation` — `HappierTone` (type)

Declared by `src/presentation/semantics.ts` as `HappierTone`.

```ts
type HappierTone = 'neutral' | 'secondary' | 'muted' | 'info' | 'success' | 'warning' | 'danger' | 'accent';
```


### `./presentation` — `HappierValidationMessage` (value)

Declared by `src/presentation/form/Fields.tsx` as `HappierValidationMessage`.

```ts
function HappierValidationMessage({ message, theme, testID, nativeID, accessibilityLiveRegion, }: HappierValidationMessageProps);
```


### `./presentation` — `HappierValidationMessageProps` (type)

Declared by `src/presentation/form/Fields.tsx` as `HappierValidationMessageProps`.

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

Declared by `src/presentation/feedback/Spinner.tsx` as `HappierWebSpinnerPresentation`.

```ts
type HappierWebSpinnerPresentation = Readonly<{
    accessibilityRole: 'progressbar';
    style: HappierWebSpinnerStyle;
}>;
```


### `./presentation` — `HappierWebSpinnerPresentationInput` (type)

Declared by `src/presentation/feedback/Spinner.tsx` as `HappierWebSpinnerPresentationInput`.

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

Declared by `src/presentation/feedback/Spinner.tsx` as `HappierWebSpinnerStyle`.

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

Declared by `src/presentation/text/textStyleScale.ts` as `ScaleTextStyleOptions`.

```ts
type ScaleTextStyleOptions = Readonly<{
    transformEntry?: TextStyleEntryTransform;
}>;
```


### `./presentation` — `ScaledTextStyleMetrics` (type)

Declared by `src/presentation/text/textStyleScale.ts` as `ScaledTextStyleMetrics`.

```ts
type ScaledTextStyleMetrics<T> = IsExactly<T, HappierStyleProp> extends true ? HappierStyleProp : T extends readonly unknown[] ? ScaledTextStyleArray<T> : T extends object ? {
    [Key in keyof T]: Key extends ScaledTextMetricKey ? ScaleTextMetricValue<T[Key]> : T[Key];
} : T;
```


### `./presentation` — `TextStyleEntryTransform` (type)

Declared by `src/presentation/text/textStyleScale.ts` as `TextStyleEntryTransform`.

```ts
type TextStyleEntryTransform = <T extends object>(entry: T, textScale: number) => T;
```


### `./presentation` — `cloneStyleEntryPreservingOwnProps` (value)

Declared by `src/presentation/text/textStyleScale.ts` as `cloneStyleEntryPreservingOwnProps`.

```ts
function cloneStyleEntryPreservingOwnProps<T extends object>(entry: T): T;
```


### `./presentation` — `iconMatchedSpinnerSize` (value)

Declared by `src/presentation/feedback/Spinner.tsx` as `iconMatchedSpinnerSize`.

```ts
function iconMatchedSpinnerSize(iconSize: number): number;
```


### `./presentation` — `isHappierBannerUrgent` (value)

Declared by `src/presentation/content/Foundation.tsx` as `isHappierBannerUrgent`.

```ts
function isHappierBannerUrgent(tone: HappierTone): boolean;
```


### `./presentation` — `isHappierIconName` (value)

Declared by `src/presentation/content/Icon.ts` as `isHappierIconName`.

```ts
function isHappierIconName(value: unknown): value is HappierIconName;
```


### `./presentation` — `isHappierTabSelected` (value)

Declared by `src/presentation/navigation/Tabs.tsx` as `isHappierTabSelected`.

```ts
function isHappierTabSelected(value: string, candidate: string): boolean;
```


### `./presentation` — `matchesHappierMenuQuery` (value)

Declared by `src/presentation/interaction/Menu.ts` as `matchesHappierMenuQuery`.

```ts
function matchesHappierMenuQuery(input: Readonly<{
    label: string;
    description?: string;
    query: string;
}>): boolean;
```


### `./presentation` — `normalizeHappierCodeLanguage` (value)

Declared by `src/presentation/content/CodeBlock.ts` as `normalizeHappierCodeLanguage`.

```ts
function normalizeHappierCodeLanguage(language: string | null | undefined): string | undefined;
```


### `./presentation` — `patchHappierActionInputPath` (value)

Declared by `src/presentation/form/actionInputFields.ts` as `patchHappierActionInputPath`.

```ts
function patchHappierActionInputPath(input: InputRecord, path: string, value: unknown): Record<string, unknown>;
```


### `./presentation` — `readHappierActionInputPath` (value)

Declared by `src/presentation/form/actionInputFields.ts` as `readHappierActionInputPath`.

```ts
function readHappierActionInputPath(input: InputRecord, path: string): unknown;
```


### `./presentation` — `resolveHappierActionFieldPresentation` (value)

Declared by `src/presentation/form/actionInputFields.ts` as `resolveHappierActionFieldPresentation`.

```ts
function resolveHappierActionFieldPresentation<OptionValue = unknown>(field: HappierActionInputField, value: unknown, selection?: OptionValue | readonly OptionValue[]): HappierActionFieldPresentation<OptionValue>;
```


### `./presentation` — `resolveHappierBrandFallback` (value)

Declared by `src/presentation/content/Image.tsx` as `resolveHappierBrandFallback`.

```ts
function resolveHappierBrandFallback(displayName: string): string;
```


### `./presentation` — `resolveHappierCodeBlockLayout` (value)

Declared by `src/presentation/content/CodeBlock.ts` as `resolveHappierCodeBlockLayout`.

```ts
function resolveHappierCodeBlockLayout(input: Pick<HappierCodeBlockBehaviorInput, 'language' | 'showHeaderRow' | 'showCopyButton' | 'hasHeaderLeft' | 'hasHeaderRight'>): { readonly language: string | undefined; readonly shouldRenderHeaderRow: boolean; readonly shouldOverlayCopyButton: boolean; };
```


### `./presentation` — `resolveHappierFormPending` (value)

Declared by `src/presentation/form/Fields.tsx` as `resolveHappierFormPending`.

```ts
function resolveHappierFormPending({ busy, implicitPending, }: HappierFormPendingInput): boolean;
```


### `./presentation` — `resolveHappierIconSize` (value)

Declared by `src/presentation/content/Icon.ts` as `resolveHappierIconSize`.

```ts
function resolveHappierIconSize(size: HappierIconSize = 'medium'): number;
```


### `./presentation` — `resolveHappierImagePixels` (value)

Declared by `src/presentation/content/Image.tsx` as `resolveHappierImagePixels`.

```ts
function resolveHappierImagePixels(size: HappierImageSize | undefined): number;
```


### `./presentation` — `resolveHappierItemBehavior` (value)

Declared by `src/presentation/collection/semantics.ts` as `resolveHappierItemBehavior`.

```ts
function resolveHappierItemBehavior(input: HappierItemBehaviorInput): HappierItemBehavior;
```


### `./presentation` — `resolveHappierItemGroupConstraints` (value)

Declared by `src/presentation/collection/semantics.ts` as `resolveHappierItemGroupConstraints`.

```ts
function resolveHappierItemGroupConstraints(input: Readonly<{
    role?: 'radiogroup';
    accessibilityLabel?: string;
    columns: number;
    virtualized: boolean;
}>): void;
```


### `./presentation` — `resolveHappierItemSemantics` (value)

Declared by `src/presentation/collection/semantics.ts` as `resolveHappierItemSemantics`.

```ts
function resolveHappierItemSemantics(input: HappierItemSemanticInput): Readonly<{
    accessibilityState?: HappierItemSemanticState;
    tabIndex: -1 | 0;
}>;
```


### `./presentation` — `resolveHappierMenuContent` (value)

Declared by `src/presentation/interaction/Menu.ts` as `resolveHappierMenuContent`.

```ts
function resolveHappierMenuContent<Item extends HappierMenuItemDescriptor>(input: Readonly<{
    items?: readonly Item[];
    groups?: readonly HappierMenuGroupDescriptor<Item>[];
}>): HappierMenuContent<Item>;
```


### `./presentation` — `resolveHappierMenuKeyAction` (value)

Declared by `src/presentation/interaction/Menu.ts` as `resolveHappierMenuKeyAction`.

```ts
function resolveHappierMenuKeyAction(key: string): HappierMenuKeyAction;
```


### `./presentation` — `resolveHappierMenuRadioGroups` (value)

Declared by `src/presentation/interaction/Menu.ts` as `resolveHappierMenuRadioGroups`.

```ts
function resolveHappierMenuRadioGroups(input: Readonly<{
    items: readonly HappierMenuItemDescriptor[];
    radioGroups: readonly HappierMenuRadioGroupDescriptor[];
}>): ReadonlyMap<string, HappierMenuRadioGroupDescriptor>;
```


### `./presentation` — `resolveHappierMenuSelection` (value)

Declared by `src/presentation/interaction/Menu.ts` as `resolveHappierMenuSelection`.

```ts
function resolveHappierMenuSelection(input: Readonly<{
    items: readonly HappierMenuItemDescriptor[];
    selectedIndex: number;
    direction: -1 | 1;
    wrap: boolean;
}>): number;
```


### `./presentation` — `resolveHappierMenuTypeahead` (value)

Declared by `src/presentation/interaction/Menu.ts` as `resolveHappierMenuTypeahead`.

```ts
function resolveHappierMenuTypeahead(input: Readonly<{
    items: readonly HappierMenuItemDescriptor[];
    selectedIndex: number;
    query: string;
}>): number;
```


### `./presentation` — `resolveHappierPopoverPlacement` (value)

Declared by `src/presentation/interaction/Menu.ts` as `resolveHappierPopoverPlacement`.

```ts
function resolveHappierPopoverPlacement(input: Readonly<{
    placement: HappierPopoverPlacement;
    available: Readonly<Record<HappierResolvedPopoverPlacement, number>>;
    preferredMinAvailable?: number;
}>): HappierResolvedPopoverPlacement;
```


### `./presentation` — `resolveHappierProgressPercentage` (value)

Declared by `src/presentation/content/Foundation.tsx` as `resolveHappierProgressPercentage`.

```ts
function resolveHappierProgressPercentage(value: number | undefined, options: Readonly<{
    indeterminate?: number;
    minimumVisible?: number;
}> = {}): number;
```


### `./presentation` — `resolveHappierRovingSelection` (value)

Declared by `src/presentation/collection/semantics.ts` as `resolveHappierRovingSelection`.

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

Declared by `src/presentation/navigation/Tabs.tsx` as `resolveHappierTabKeySelection`.

```ts
function resolveHappierTabKeySelection<T extends object>(input: Readonly<{
    tabs: readonly T[];
    currentIndex: number;
    key: string;
    rtl: boolean;
}>): number | null;
```


### `./presentation` — `resolveHappierWebSpinnerPresentation` (value)

Declared by `src/presentation/feedback/Spinner.tsx` as `resolveHappierWebSpinnerPresentation`.

```ts
function resolveHappierWebSpinnerPresentation(input: HappierWebSpinnerPresentationInput): HappierWebSpinnerPresentation | null;
```


### `./presentation` — `scaleTextStyleMetrics` (value)

Declared by `src/presentation/text/textStyleScale.ts` as `scaleTextStyleMetrics`.

```ts
function scaleTextStyleMetrics<T>(style: T, textScale: number, options: ScaleTextStyleOptions = {}): ScaledTextStyleMetrics<T>;
```


### `./presentation` — `useHappierCodeBlockBehavior` (value)

Declared by `src/presentation/content/CodeBlock.ts` as `useHappierCodeBlockBehavior`.

```ts
function useHappierCodeBlockBehavior(input: HappierCodeBlockBehaviorInput): { readonly copied: boolean; readonly copy: () => Promise<boolean>; readonly language: string | undefined; readonly shouldRenderHeaderRow: boolean; readonly shouldOverlayCopyButton: boolean; };
```


### `./presentation` — `useHappierFormSubmission` (value)

Declared by `src/presentation/form/Fields.tsx` as `useHappierFormSubmission`.

```ts
function useHappierFormSubmission(busy?: boolean): Readonly<{
    pending: boolean;
    submit: (operation: () => unknown) => void;
}>;
```


### `./presentation` — `useHappierItemGroupItemBehavior` (value)

Declared by `src/presentation/collection/ItemGroup.tsx` as `useHappierItemGroupItemBehavior`.

```ts
function useHappierItemGroupItemBehavior(input: HappierItemGroupItemBehaviorInput): { readonly grouped: boolean; readonly onKeyDown: (key: string) => boolean; readonly selectableItemCount: number | undefined; readonly tabStopIndex: number | null | undefined; readonly targetRef: (target: HappierItemGroupRadioFocusable | null) => void; };
```


### `./presentation` — `useHappierMenuInteraction` (value)

Declared by `src/presentation/interaction/Menu.ts` as `useHappierMenuInteraction`.

```ts
function useHappierMenuInteraction<Item extends HappierMenuInteractionItem>(input: HappierMenuInteractionInput<Item>): { readonly selectedIndex: number; readonly setSelectedIndex: (index: number) => void; readonly handleKeyPress: (key: string, onActivate: (item: Item) => void, activeIndex?: number) => boolean; };
```


### `./presentation` — `useHappierTabPanelActivity` (value)

Declared by `src/presentation/navigation/Tabs.tsx` as `useHappierTabPanelActivity`.

```ts
function useHappierTabPanelActivity(): HappierTabPanelActivity;
```


### `./presentation` — `useHappierTextPresentation` (value)

Declared by `src/presentation/text/Text.tsx` as `useHappierTextPresentation`.

```ts
function useHappierTextPresentation({ selectable, textScale, }: HappierTextPresentationInput): HappierTextPresentation;
```


### `./presentation` — `writeHappierActionInputPath` (value)

Declared by `src/presentation/form/actionInputFields.ts` as `writeHappierActionInputPath`.

```ts
function writeHappierActionInputPath(input: InputRecord, path: string, value: unknown): Record<string, unknown>;
```


### `./testing` — `PluginUiRnwSemanticSurfaceAdapterOptions` (type)

Declared by `src/testing/rnwSemanticAdapter.tsx` as `PluginUiRnwSemanticSurfaceAdapterOptions`.

```ts
type PluginUiRnwSemanticSurfaceAdapterOptions = Readonly<{
    targetedSurfaces?: Readonly<{
        readCurrentMounts(): unknown;
        readContributorManifest(pluginId: string): unknown;
    }>;
}>;
```


### `./testing` — `createPluginUiRnwSemanticSurfaceAdapter` (value)

Declared by `src/testing/rnwSemanticAdapter.tsx` as `createPluginUiRnwSemanticSurfaceAdapter`.

```ts
function createPluginUiRnwSemanticSurfaceAdapter(options: PluginUiRnwSemanticSurfaceAdapterOptions = {}): PluginUiSemanticSurfaceAdapter<RenderSurface>;
```


## Reachable package-owned declarations

### `src/components/Action.tsx` — `ActionChromeProps`

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


### `src/components/Action.tsx` — `ActionGroupProps`

Reached from a published signature; not itself a published export.

```ts
type ActionGroupProps = Readonly<{
    title?: string;
    titleKey?: string;
    testID?: string;
    children?: ReactNode;
}>;
```


### `src/components/Button.tsx` — `ButtonCommonProps`

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


### `src/components/Button.tsx` — `ButtonWithExplicitAccessibleNameProps`

Reached from a published signature; not itself a published export.

```ts
type ButtonWithExplicitAccessibleNameProps = ButtonCommonProps & Readonly<{
    accessibilityLabel: string;
}>;
```


### `src/components/Button.tsx` — `ButtonWithVisibleTitleProps`

Reached from a published signature; not itself a published export.

```ts
type ButtonWithVisibleTitleProps = ButtonCommonProps & Readonly<{
    title: string;
    accessibilityLabel?: string;
}>;
```


### `src/components/Focus.tsx` — `FocusBinding`

Reached from a published signature; not itself a published export.

```ts
type FocusBinding = Readonly<{
    host: PluginUiPresentationHost;
    target: unknown;
}>;
```


### `src/components/Form.tsx` — `FormFieldHints`

Reached from a published signature; not itself a published export.

```ts
type FormFieldHints = Readonly<{
    path: string;
    title: string;
    description?: string;
    placeholder?: string;
    widget: 'text' | 'url' | 'secret' | 'textarea' | 'number' | 'integer' | 'text_list' | 'select' | 'multiselect' | 'boolean' | 'json';
    required?: boolean;
    requireExplicitSelection?: boolean;
    listSeparator?: 'comma' | 'newline';
    maxSelections?: number;
    options?: readonly FormHintOption[];
    visibleWhen?: FormPredicate;
    requiredWhen?: FormPredicate;
    disabledWhen?: FormPredicate;
}>;
```


### `src/components/Form.tsx` — `FormHintOption`

Reached from a published signature; not itself a published export.

```ts
type FormHintOption = Readonly<{
    value: FormOptionValue;
    label: string;
    description?: string;
    disabled?: boolean;
}>;
```


### `src/components/Form.tsx` — `FormHints`

Reached from a published signature; not itself a published export.

```ts
type FormHints = Readonly<{
    title?: string;
    description?: string;
    submitLabel?: string;
    fields: readonly FormFieldHints[];
}>;
```


### `src/components/Form.tsx` — `FormOption`

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


### `src/components/Form.tsx` — `FormOptionValue`

Reached from a published signature; not itself a published export.

```ts
type FormOptionValue = string | Readonly<{
    service: Readonly<{
        pluginId: string;
        localId: string;
    }>;
    accountId: string;
}>;
```


### `src/components/Form.tsx` — `FormPredicate`

Reached from a published signature; not itself a published export.

```ts
type FormPredicate = Readonly<{
    op: 'truthy';
    path: string;
}> | Readonly<{
    op: 'eq';
    path: string;
    value: FormPrimitive;
}> | Readonly<{
    op: 'includes';
    path: string;
    value: string;
}> | Readonly<{
    op: 'not';
    predicate: FormPredicate;
}> | Readonly<{
    op: 'and';
    all: readonly FormPredicate[];
}> | Readonly<{
    op: 'or';
    any: readonly FormPredicate[];
}>;
```


### `src/components/Form.tsx` — `FormPrimitive`

Reached from a published signature; not itself a published export.

```ts
type FormPrimitive = string | number | boolean | null;
```


### `src/components/Foundation.tsx` — `AuthorText`

Reached from a published signature; not itself a published export.

```ts
type AuthorText = Readonly<{
    value?: string;
    valueKey?: string;
    fallback?: string;
}>;
```


### `src/components/List.tsx` — `FlatVirtualizedListProps`

Reached from a published signature; not itself a published export.

```ts
type FlatVirtualizedListProps<Item> = VirtualizedListSharedProps<Item> & Readonly<{
    items: readonly Item[];
    sections?: never;
}>;
```


### `src/components/List.tsx` — `ItemSecondaryAction`

Reached from a published signature; not itself a published export.

```ts
type ItemSecondaryAction = Readonly<{
    id: string;
    label: string;
    disabled?: boolean;
    icon?: ReactNode;
}>;
```


### `src/components/List.tsx` — `ItemSecondaryActionsProps`

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


### `src/components/List.tsx` — `ListBaseProps`

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


### `src/components/List.tsx` — `ListSearchBaseProps`

Reached from a published signature; not itself a published export.

```ts
type ListSearchBaseProps<Item> = Readonly<{
    label: string;
    placeholder?: string;
    testID?: string;
    filter: (item: Item, query: string) => boolean;
}>;
```


### `src/components/List.tsx` — `ListSelectionBaseProps`

Reached from a published signature; not itself a published export.

```ts
type ListSelectionBaseProps<Item> = Readonly<{
    isItemDisabled?: (item: Item, index: number) => boolean;
    onFocusedKeyChange?: (key: string) => void;
}>;
```


### `src/components/List.tsx` — `SectionedVirtualizedListProps`

Reached from a published signature; not itself a published export.

```ts
type SectionedVirtualizedListProps<Item> = VirtualizedListSharedProps<Item> & Readonly<{
    items?: never;
    sections: readonly ListSectionData<Item>[];
}>;
```


### `src/components/List.tsx` — `StaticListProps`

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


### `src/components/List.tsx` — `VirtualizedListProps`

Reached from a published signature; not itself a published export.

```ts
type VirtualizedListProps<Item> = FlatVirtualizedListProps<Item> | SectionedVirtualizedListProps<Item>;
```


### `src/components/List.tsx` — `VirtualizedListSharedProps`

Reached from a published signature; not itself a published export.

```ts
type VirtualizedListSharedProps<Item> = Readonly<{
    keyForItem: (item: Item, index: number) => string;
    renderItem: (item: Item, index: number, sectionKey: string | null) => ReactNode;
    header?: ReactNode | ((context: ListHeaderContext<Item>) => ReactNode);
    search?: ListSearchProps<Item>;
    selection?: ListSelectionProps<Item>;
    empty?: ReactNode;
    footer?: ReactNode;
    contentContainerStyle?: HappierStyleProp;
    children?: never;
}>;
```


### `src/components/Overlay.tsx` — `MenuContentProps`

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


### `src/components/Overlay.tsx` — `MenuItemBase`

Reached from a published signature; not itself a published export.

```ts
type MenuItemBase = Readonly<{
    id: string;
    label: string;
    disabled?: boolean;
}>;
```


### `src/components/State.tsx` — `StateCopyProps`

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


### `src/components/TargetedSurface.tsx` — `TargetedSurfaceInput`

Reached from a published signature; not itself a published export.

```ts
type TargetedSurfaceInput<TSurface extends PluginUiTargetedContributionSurfaceV1> = TSurface extends ContributionSurfaceHandle<infer TInput, infer _TPointId> ? TInput : JsonValue;
```


### `src/composer/hooks.ts` — `ComposerViewStateInternal`

Reached from a published signature; not itself a published export.

```ts
type ComposerViewStateInternal = Readonly<{
    handle: ComposerHandle | null;
    result: ComposerReadResultV1 | null;
    error: PluginError | null;
    pending: ComposerViewStateV1['pending'];
}>;
```


### `src/data/index.ts` — `QueryOpenState`

Reached from a published signature; not itself a published export.

```ts
type QueryOpenState = Readonly<{
    client: ReturnType<typeof usePluginUiDataClient> | null;
    key: string;
    pager: PluginUiCollectionQueryPager | null;
    error: Error | null;
}>;
```


### `src/hostApi/context.ts` — `PluginHostApiProviderInternalProps`

Reached from a published signature; not itself a published export.

```ts
type PluginHostApiProviderInternalProps = PluginHostApiProviderProps & Readonly<{
    accountLifetime?: PluginUiResourceAccountLifetime | null;
    resourceStoreGeneration?: unknown;
    mountedPluginId?: string;
    composerRef?: ComposerRefV1 | null;
}>;
```


### `src/hostApi/executeAction.ts` — `PluginUiActionExecutionWithOptionalInput`

Reached from a published signature; not itself a published export.

```ts
type PluginUiActionExecutionWithOptionalInput = (action: PluginUiActionReference, input?: JsonValue, options?: PluginUiActionExecutionOptions) => Promise<JsonValue>;
```


### `src/hostApi/resourceStore.ts` — `MutableEntry`

Reached from a published signature; not itself a published export.

```ts
type MutableEntry = {
    readonly key: string;
    readonly resource: PluginUiResourceReference;
    readonly listeners: Set<() => void>;
    snapshot: PluginUiResourceSnapshot;
    subscriberCount: number;
    liveSubscriberCount: number;
    disposed: boolean;
    reading: boolean;
    readQueued: boolean;
    readQueuedRetainsFreshSnapshot: boolean;
    readQueuedExpectedDigest: string | null;
    readController: AbortController | null;
    watchController: AbortController | null;
    watch: Disposable | null;
    watchEstablishing: boolean;
    watchUnsupported: boolean;
    watchFailureTerminal: boolean;
    watchRetryTimer: ReturnType<typeof setTimeout> | null;
    watchRetryAttempts: number;
};
```


### `src/presentation/collection/ItemGroup.tsx` — `HappierItemGroupRadioContext`

Reached from a published signature; not itself a published export.

```ts
type HappierItemGroupRadioContext = Readonly<{
    tabStopIndex: number | null;
    register(index: number, target: HappierItemGroupRadioFocusable | null): () => void;
    move(index: number, key: string): boolean;
}>;
```


### `src/presentation/collection/semantics.ts` — `HappierRovingCollectionItem`

Reached from a published signature; not itself a published export.

```ts
type HappierRovingCollectionItem = Readonly<{
    isTabStop: boolean;
    onKeyDown: (key: string) => boolean;
    register: (target: HappierFocusable | null) => void;
}>;
```


### `src/presentation/form/Fields.tsx` — `HappierFieldIssueSemantics`

Reached from a published signature; not itself a published export.

```ts
type HappierFieldIssueSemantics = Readonly<{
    invalid: boolean;
    issueId?: string;
    issueHint?: string;
}>;
```


### `src/presentation/form/actionInputFields.ts` — `HappierActionInputField`

Reached from a published signature; not itself a published export.

```ts
type HappierActionInputField = Readonly<{
    widget: 'boolean' | 'select' | 'multiselect' | 'json' | 'text_list' | 'secret' | 'textarea' | 'url' | 'number' | 'integer' | string;
    listSeparator?: 'comma' | 'newline';
}>;
```


### `src/presentation/form/actionInputFields.ts` — `InputRecord`

Reached from a published signature; not itself a published export.

```ts
type InputRecord = Readonly<Record<string, unknown>>;
```


### `src/presentation/interaction/Menu.ts` — `HappierMenuInteractionItem`

Reached from a published signature; not itself a published export.

```ts
type HappierMenuInteractionItem = Readonly<{
    id: string;
    disabled?: boolean;
}>;
```


### `src/presentation/interaction/Pressable.tsx` — `WebPressState`

Reached from a published signature; not itself a published export.

```ts
type WebPressState = Readonly<{
    pressed: boolean;
    hovered?: boolean;
    focused?: boolean;
}>;
```


### `src/presentation/portableTypes.ts` — `HappierAccessibilityLiveRegion`

Reached from a published signature; not itself a published export.

```ts
type HappierAccessibilityLiveRegion = 'none' | 'polite' | 'assertive';
```


### `src/presentation/portableTypes.ts` — `HappierActivityIndicatorHostProps`

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


### `src/presentation/portableTypes.ts` — `HappierAlignment`

Reached from a published signature; not itself a published export.

```ts
type HappierAlignment = 'baseline' | 'center' | 'flex-end' | 'flex-start' | 'stretch';
```


### `src/presentation/portableTypes.ts` — `HappierDimension`

Reached from a published signature; not itself a published export.

```ts
type HappierDimension = number | `${number}%` | 'auto';
```


### `src/presentation/portableTypes.ts` — `HappierFocusable`

Reached from a published signature; not itself a published export.

```ts
type HappierFocusable = Readonly<{
    focus?: () => void;
}>;
```


### `src/presentation/portableTypes.ts` — `HappierFontWeight`

Reached from a published signature; not itself a published export.

```ts
type HappierFontWeight = 'normal' | 'bold' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900' | 'ultralight' | 'thin' | 'light' | 'medium' | 'regular' | 'semibold' | 'condensedBold' | 'condensed' | 'heavy' | 'black' | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;
```


### `src/presentation/portableTypes.ts` — `HappierGestureResponderEvent`

Reached from a published signature; not itself a published export.

```ts
type HappierGestureResponderEvent = Readonly<{
    nativeEvent: unknown;
    preventDefault?: () => void;
    stopPropagation?: () => void;
}>;
```


### `src/presentation/portableTypes.ts` — `HappierJustification`

Reached from a published signature; not itself a published export.

```ts
type HappierJustification = 'center' | 'flex-end' | 'flex-start' | 'space-around' | 'space-between' | 'space-evenly';
```


### `src/presentation/portableTypes.ts` — `HappierKeyboardShouldPersistTaps`

Reached from a published signature; not itself a published export.

```ts
type HappierKeyboardShouldPersistTaps = boolean | 'always' | 'never' | 'handled';
```


### `src/presentation/portableTypes.ts` — `HappierLayoutChangeEvent`

Reached from a published signature; not itself a published export.

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


### `src/presentation/portableTypes.ts` — `HappierPortableStyle`

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


### `src/presentation/portableTypes.ts` — `HappierScrollEvent`

Reached from a published signature; not itself a published export.

```ts
type HappierScrollEvent = Readonly<{
    nativeEvent: unknown;
}>;
```


### `src/presentation/portableTypes.ts` — `HappierStyleProp`

Reached from a published signature; not itself a published export.

```ts
type HappierStyleProp = HappierPortableStyle | false | null | undefined | HappierStyleProp[];
```


### `src/presentation/portableTypes.ts` — `HappierTextHostProps`

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


### `src/presentation/text/textStyleScale.ts` — `IsExactly`

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


### `src/presentation/text/textStyleScale.ts` — `ScaleTextMetricValue`

Reached from a published signature; not itself a published export.

```ts
type ScaleTextMetricValue<Value> = Value extends number ? number : Value;
```


### `src/presentation/text/textStyleScale.ts` — `ScaledTextMetricKey`

Reached from a published signature; not itself a published export.

```ts
type ScaledTextMetricKey = 'fontSize' | 'lineHeight' | 'letterSpacing';
```


### `src/presentation/text/textStyleScale.ts` — `ScaledTextStyleArray`

Reached from a published signature; not itself a published export.

```ts
type ScaledTextStyleArray<T extends readonly unknown[]> = number extends T['length'] ? T extends unknown[] ? ScaledTextStyleMetrics<T[number]>[] : readonly ScaledTextStyleMetrics<T[number]>[] : {
    [Index in keyof T]: ScaledTextStyleMetrics<T[Index]>;
};
```


### `src/presentationHost/context.ts` — `PluginUiPopoverContentControls`

Reached from a published signature; not itself a published export.

```ts
type PluginUiPopoverContentControls = Readonly<{
    requestClose(reason: 'selection' | 'escape'): void;
    maxHeight: number;
}>;
```


### `src/presentationHost/context.ts` — `PluginUiPopoverPresentation`

Reached from a published signature; not itself a published export.

```ts
type PluginUiPopoverPresentation = 'popover' | 'menu' | 'dropdown' | 'context';
```


### `src/presentationHost/context.ts` — `PluginUiPresentationHost`

Reached from a published signature; not itself a published export.

```ts
type PluginUiPresentationHost = Readonly<{
    brand?: Readonly<{
        displayName: string;
        resource?: Readonly<{
            pluginId: string;
            localId: string;
        }>;
    }>;
    resolveBrandDisplayName?(pluginId: string): string | undefined;
    renderBrandMark?(input: PluginUiTargetBrandMarkInput): ReactElement | undefined;
    renderTargetedSurface?(input: PluginUiTargetedSurfacePresentation): ReactNode;
    targetedSurfaceUnavailableReason?: 'unsupported_nested_targeted_surface';
    focusTarget?(target: unknown): boolean;
    renderMarkdown(input: Readonly<{
        value: string;
        selectable: boolean;
        testID?: string;
    }>): ReactNode;
    renderCodeBlock(input: Readonly<{
        code: string;
        language?: string;
        selectable: boolean;
        testID?: string;
    }>): ReactNode;
    renderPopover(input: Readonly<{
        open: boolean;
        anchorRef: RefObject<unknown>;
        followScrollRef?: RefObject<unknown>;
        focusReturnRef?: RefObject<unknown>;
        initialFocusRef?: RefObject<unknown>;
        placement?: 'auto' | 'top' | 'bottom' | 'left' | 'right';
        presentation?: PluginUiPopoverPresentation;
        autoFocusOnOpen?: boolean;
        onRequestClose(): void;
        content(controls: PluginUiPopoverContentControls): ReactNode;
    }>): ReactNode;
    renderIcon(input: Readonly<{
        name: string;
        size: number;
        color?: string;
        accessibilityLabel?: string;
        testID?: string;
    }>): ReactNode;
}>;
```


### `src/presentationHost/context.ts` — `PluginUiTargetBrandMarkInput`

Reached from a published signature; not itself a published export.

```ts
type PluginUiTargetBrandMarkInput = Readonly<{
    pluginId: string;
    size?: 'small' | 'medium' | 'large';
    showName?: boolean;
    externallyLabelled?: boolean;
    testID?: string;
}>;
```


### `src/presentationHost/context.ts` — `PluginUiTargetedSurfacePresentation`

Reached from a published signature; not itself a published export.

```ts
type PluginUiTargetedSurfacePresentation = Readonly<{
    surface: PluginUiTargetedContributionSurfaceV1;
    input: JsonValue;
    instanceKey?: string;
    fallback?: ReactNode;
}>;
```


## Referenced declarations owned by other packages

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
- `@happier-dev/plugin-sdk#PluginUiSemanticAdapterNode`
- `@happier-dev/plugin-sdk#PluginUiSemanticSurfaceAdapter`
- `@happier-dev/plugin-sdk#PluginUiSemanticSurfaceMount`
- `@happier-dev/plugin-sdk#PluginUiTargetedContributionSurfaceV1`
- `@happier-dev/plugin-sdk#PluginUiThemeV1`
- `@happier-dev/plugin-sdk#ProtocolJsonValue`
- `@happier-dev/plugin-sdk#RenderContext`
- `@happier-dev/plugin-sdk#RenderSurface`
- `@happier-dev/plugin-sdk#ResourceContent`
- `@happier-dev/plugin-sdk#ResourceSubscriptionEvent`
- `@happier-dev/plugin-sdk#SurfaceContext`
- `@happier-dev/protocol#PluginCollectionUiQueryErrorV1`
- `@happier-dev/protocol#PluginCollectionUiQueryRequestV1`
- `@happier-dev/protocol#PluginCollectionUiQueryResultV1`
- `@types/node#AbortController`
- `@types/node#AbortSignal`
- `@types/node#setTimeout`
- `@types/react#ComponentType`
- `@types/react#HTMLElement`
- `@types/react#React`
- `@types/react#ReactElement`
- `@types/react#ReactNode`
- `@types/react#RefObject`
- `react-native#ScrollView`
- `react-native#StyleProp`
- `react-native#TextStyle`
- `react-native#View`
- `react-native#ViewStyle`
- `react-native#setTimeout`
