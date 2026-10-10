# Embed public declaration report

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

### `.` — `EmbedColorTokenId` (type)

Declared by `dist/themeTokenIds.d.ts` as `EmbedColorTokenId`.

```ts
type EmbedColorTokenId = typeof EMBED_COLOR_TOKEN_IDS[number];
```


### `.` — `EmbedCredential` (type)

Declared by `dist/types.d.ts` as `EmbedCredential`.

```ts
type EmbedCredential = EmbedCredentialInputV1;
```


### `.` — `EmbedCredentialRequest` (type)

Declared by `dist/types.d.ts` as `EmbedCredentialRequest`.

```ts
type EmbedCredentialRequest = Omit<EmbedCredentialRequestV1, 'kind'>;
```


### `.` — `EmbedError` (type)

Declared by `dist/types.d.ts` as `EmbedError`.

```ts
type EmbedError = EmbedErrorCodeV1 | 'frame_unreachable';
```


### `.` — `EmbedHandle` (type)

Declared by `dist/types.d.ts` as `EmbedHandle`.

```ts
interface EmbedHandle {
    open(sessionId: string | null): void;
    update(options: EmbedUpdate): void;
    destroy(): void;
}
```


### `.` — `EmbedOptions` (type)

Declared by `dist/types.d.ts` as `EmbedOptions`.

```ts
interface EmbedOptions {
    happierUrl: string;
    sessionId?: string | null;
    getCredential(request: EmbedCredentialRequest): Promise<EmbedCredential>;
    title?: string;
    ui?: EmbedUiOverridesV1;
    style?: EmbedStyle;
    onStateChange?(state: EmbedState): void;
    onSessionCreated?(event: EmbedSessionCreated): void;
    onError?(code: EmbedError): void;
}
```


### `.` — `EmbedSessionCreated` (type)

Declared by `dist/types.d.ts` as `EmbedSessionCreated`.

```ts
type EmbedSessionCreated = Readonly<{
    sessionId: string;
}>;
```


### `.` — `EmbedState` (type)

Declared by `dist/types.d.ts` as `EmbedState`.

```ts
type EmbedState = Omit<EmbedStateV1, 'kind'>;
```


### `.` — `EmbedStyle` (type)

Declared by `dist/types.d.ts` as `EmbedStyle`.

```ts
type EmbedStyle = Omit<EmbedStyleV1, 'v' | 'colors'> & {
    v?: 1;
    colors?: {
        light?: Partial<Record<EmbedColorTokenId, string>>;
        dark?: Partial<Record<EmbedColorTokenId, string>>;
    };
};
```


### `.` — `EmbedUpdate` (type)

Declared by `dist/types.d.ts` as `EmbedUpdate`.

```ts
type EmbedUpdate = Partial<Pick<EmbedOptions, 'title' | 'ui' | 'style'>>;
```


### `.` — `mountHappierSession` (value)

Declared by `dist/mount.d.ts` as `mountHappierSession`.

```ts
function mountHappierSession(container: HTMLElement, options: EmbedOptions): EmbedHandle;
```


### `./react` — `HappierSession` (value)

Declared by `dist/react/index.d.ts` as `HappierSession`.

```ts
function HappierSession(props: HappierSessionProps): ReactElement;
```


### `./react` — `HappierSessionProps` (type)

Declared by `dist/react/index.d.ts` as `HappierSessionProps`.

```ts
type HappierSessionProps = EmbedOptions & {
    className?: string;
    containerStyle?: CSSProperties;
};
```


## Reachable package-owned declarations

### `dist/themeTokenIds.d.ts` — `EMBED_COLOR_TOKEN_IDS`

Reached from a published signature; not itself a published export.

```ts
const EMBED_COLOR_TOKEN_IDS: readonly [
    "background.canvas",
    "border.default",
    "border.focus",
    "border.modal",
    "border.strong",
    "border.surface",
    "chrome.header.background",
    "chrome.header.foreground",
    "composer.chipTint",
    "control.button.primary.background",
    "control.button.primary.disabled",
    "control.button.primary.foreground",
    "control.button.secondary.background",
    "control.button.secondary.foreground",
    "control.fab.background",
    "control.fab.backgroundPressed",
    "control.fab.foreground",
    "control.input.background",
    "control.input.foreground",
    "control.input.placeholder",
    "control.permissionButton.allow.background",
    "control.permissionButton.allow.foreground",
    "control.permissionButton.allowAll.background",
    "control.permissionButton.allowAll.foreground",
    "control.permissionButton.deny.background",
    "control.permissionButton.deny.foreground",
    "control.permissionButton.inactive.background",
    "control.permissionButton.inactive.border",
    "control.permissionButton.inactive.foreground",
    "control.permissionButton.selected.background",
    "control.permissionButton.selected.border",
    "control.permissionButton.selected.foreground",
    "control.radio.active",
    "control.radio.dot",
    "control.radio.inactive",
    "control.segmentedControl.activeBackground",
    "control.segmentedControl.trackBackground",
    "control.switch.thumb.active",
    "control.switch.thumb.inactive",
    "control.switch.track.active",
    "control.switch.track.inactive",
    "diff.added.background",
    "diff.added.foreground",
    "diff.context.foreground",
    "diff.hunk.background",
    "diff.hunk.foreground",
    "diff.inlineAdded.background",
    "diff.inlineAdded.foreground",
    "diff.inlineRemoved.background",
    "diff.inlineRemoved.foreground",
    "diff.removed.background",
    "diff.removed.foreground",
    "effect.surfaceHighlight",
    "message.agent.foreground",
    "message.event.foreground",
    "message.user.background",
    "message.user.foreground",
    "overlay.foreground",
    "overlay.scrim",
    "overlay.scrimSoft",
    "overlay.scrimStrong",
    "overlay.scrimWizard",
    "overlay.secondaryForeground",
    "permission.acceptEdits",
    "permission.bypass",
    "permission.default",
    "permission.plan",
    "permission.readOnly",
    "permission.safeYolo",
    "permission.yolo",
    "state.active.background",
    "state.active.border",
    "state.active.foreground",
    "state.danger.background",
    "state.danger.border",
    "state.danger.foreground",
    "state.info.background",
    "state.info.border",
    "state.info.foreground",
    "state.neutral.background",
    "state.neutral.border",
    "state.neutral.foreground",
    "state.success.background",
    "state.success.border",
    "state.success.foreground",
    "state.warning.background",
    "state.warning.border",
    "state.warning.foreground",
    "surface.base",
    "surface.elevated",
    "surface.inset",
    "surface.pressed",
    "surface.pressedOverlay",
    "surface.ripple",
    "surface.sectionTint",
    "surface.selected",
    "syntax.comment",
    "syntax.default",
    "syntax.function",
    "syntax.keyword",
    "syntax.number",
    "syntax.string",
    "text.destructive",
    "text.disabled",
    "text.link",
    "text.placeholder",
    "text.primary",
    "text.secondary",
    "text.tertiary",
    "versionControl.added.background",
    "versionControl.added.foreground",
    "versionControl.removed.background",
    "versionControl.removed.foreground"
];
```


### `node_modules/@happier-dev/protocol/dist/embed/embedBridgeV1.d.ts` — `EmbedCredentialInputV1`

Reached from a published signature; not itself a published export.

```ts
type EmbedCredentialInputV1 = z.infer<typeof EmbedCredentialInputV1Schema>;
```


### `node_modules/@happier-dev/protocol/dist/embed/embedBridgeV1.d.ts` — `EmbedCredentialInputV1Schema`

Reached from a published signature; not itself a published export.

```ts
const EmbedCredentialInputV1Schema: z.ZodUnion<readonly [
    z.ZodObject<{
        token: z.ZodString;
        expiresAt: z.ZodString;
        sessionKey: z.ZodOptional<z.ZodString>;
        sessionOptions: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>,
    z.ZodObject<{
        token: z.ZodString;
        expiresAt: z.ZodString;
        sessionKey: z.ZodOptional<z.ZodString>;
        sessionOptions: z.ZodOptional<z.ZodString>;
        tokenId: z.ZodString;
    }, z.core.$strict>
]>;
```


### `node_modules/@happier-dev/protocol/dist/embed/embedBridgeV1.d.ts` — `EmbedCredentialRequestV1`

Reached from a published signature; not itself a published export.

```ts
type EmbedCredentialRequestV1 = z.infer<typeof EmbedCredentialRequestV1Schema>;
```


### `node_modules/@happier-dev/protocol/dist/embed/embedBridgeV1.d.ts` — `EmbedCredentialRequestV1Schema`

Reached from a published signature; not itself a published export.

```ts
const EmbedCredentialRequestV1Schema: z.ZodObject<{
    kind: z.ZodLiteral<"credential.request">;
    sessionId: z.ZodOptional<z.ZodType<string, string, z.core.$ZodTypeInternals<string, string>>>;
    embedPublicKey: z.ZodString;
    reason: z.ZodEnum<{
        created: "created";
        expiring: "expiring";
        initial: "initial";
        open: "open";
        rejected: "rejected";
    }>;
    createdByTokenId: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
```


### `node_modules/@happier-dev/protocol/dist/embed/embedBridgeV1.d.ts` — `EmbedErrorCodeV1`

Reached from a published signature; not itself a published export.

```ts
type EmbedErrorCodeV1 = z.infer<typeof EmbedErrorCodeV1Schema>;
```


### `node_modules/@happier-dev/protocol/dist/embed/embedBridgeV1.d.ts` — `EmbedErrorCodeV1Schema`

Reached from a published signature; not itself a published export.

```ts
const EmbedErrorCodeV1Schema: z.ZodEnum<{
    create_not_granted: "create_not_granted";
    credential_rejected: "credential_rejected";
    credential_unavailable: "credential_unavailable";
    origin_not_allowed: "origin_not_allowed";
    session_key_invalid: "session_key_invalid";
    session_key_not_transferable: "session_key_not_transferable";
    session_key_unavailable: "session_key_unavailable";
    session_not_found: "session_not_found";
    unsupported_bridge_version: "unsupported_bridge_version";
}>;
```


### `node_modules/@happier-dev/protocol/dist/embed/embedBridgeV1.d.ts` — `EmbedStateV1`

Reached from a published signature; not itself a published export.

```ts
type EmbedStateV1 = z.infer<typeof EmbedStateV1Schema>;
```


### `node_modules/@happier-dev/protocol/dist/embed/embedBridgeV1.d.ts` — `EmbedStateV1Schema`

Reached from a published signature; not itself a published export.

```ts
const EmbedStateV1Schema: z.ZodObject<{
    kind: z.ZodLiteral<"state">;
    sessionId: z.ZodNullable<z.ZodType<string, string, z.core.$ZodTypeInternals<string, string>>>;
    phase: z.ZodEnum<{
        error: "error";
        loading: "loading";
        ready: "ready";
    }>;
    activity: z.ZodOptional<z.ZodEnum<{
        idle: "idle";
        needs_attention: "needs_attention";
        working: "working";
    }>>;
    error: z.ZodOptional<z.ZodEnum<{
        create_not_granted: "create_not_granted";
        credential_rejected: "credential_rejected";
        credential_unavailable: "credential_unavailable";
        origin_not_allowed: "origin_not_allowed";
        session_key_invalid: "session_key_invalid";
        session_key_not_transferable: "session_key_not_transferable";
        session_key_unavailable: "session_key_unavailable";
        session_not_found: "session_not_found";
        unsupported_bridge_version: "unsupported_bridge_version";
    }>>;
}, z.core.$strict>;
```


### `node_modules/@happier-dev/protocol/dist/embed/embedBridgeV1.d.ts` — `EmbedUiOverridesV1`

Reached from a published signature; not itself a published export.

```ts
type EmbedUiOverridesV1 = z.infer<typeof EmbedUiOverridesV1Schema>;
```


### `node_modules/@happier-dev/protocol/dist/embed/embedBridgeV1.d.ts` — `EmbedUiOverridesV1Schema`

Reached from a published signature; not itself a published export.

```ts
const EmbedUiOverridesV1Schema: z.ZodObject<{
    attachments: z.ZodOptional<z.ZodBoolean>;
    modelPicker: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
```


### `node_modules/@happier-dev/protocol/dist/embed/embedStyleV1.d.ts` — `EmbedStyleV1`

Reached from a published signature; not itself a published export.

```ts
type EmbedStyleV1 = z.infer<typeof EmbedStyleV1Schema>;
```


### `node_modules/@happier-dev/protocol/dist/embed/embedStyleV1.d.ts` — `EmbedStyleV1Schema`

Reached from a published signature; not itself a published export.

```ts
const EmbedStyleV1Schema: z.ZodObject<{
    v: z.ZodLiteral<1>;
    mode: z.ZodOptional<z.ZodEnum<{
        dark: "dark";
        light: "light";
        system: "system";
    }>>;
    preset: z.ZodOptional<z.ZodString>;
    colors: z.ZodOptional<z.ZodObject<{
        light: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        dark: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, z.core.$strict>>;
    typography: z.ZodOptional<z.ZodObject<{
        fontFamily: z.ZodOptional<z.ZodString>;
        monoFontFamily: z.ZodOptional<z.ZodString>;
        fontUrl: z.ZodOptional<z.ZodString>;
        scale: z.ZodOptional<z.ZodEnum<{
            compact: "compact";
            default: "default";
            large: "large";
        }>>;
    }, z.core.$strict>>;
    radius: z.ZodOptional<z.ZodEnum<{
        round: "round";
        sharp: "sharp";
        soft: "soft";
    }>>;
    density: z.ZodOptional<z.ZodEnum<{
        comfortable: "comfortable";
        compact: "compact";
    }>>;
    parts: z.ZodOptional<z.ZodObject<{
        userBubble: z.ZodOptional<z.ZodObject<{
            radius: z.ZodOptional<z.ZodEnum<{
                lg: "lg";
                md: "md";
                modalCard: "modalCard";
                sm: "sm";
                xl: "xl";
                xxl: "xxl";
            }>>;
        }, z.core.$strict>>;
        composer: z.ZodOptional<z.ZodObject<{
            radius: z.ZodOptional<z.ZodEnum<{
                lg: "lg";
                md: "md";
                modalCard: "modalCard";
                sm: "sm";
                xl: "xl";
                xxl: "xxl";
            }>>;
        }, z.core.$strict>>;
        toolCard: z.ZodOptional<z.ZodObject<{
            radius: z.ZodOptional<z.ZodEnum<{
                lg: "lg";
                md: "md";
                modalCard: "modalCard";
                sm: "sm";
                xl: "xl";
                xxl: "xxl";
            }>>;
        }, z.core.$strict>>;
        approvalCard: z.ZodOptional<z.ZodObject<{
            radius: z.ZodOptional<z.ZodEnum<{
                lg: "lg";
                md: "md";
                modalCard: "modalCard";
                sm: "sm";
                xl: "xl";
                xxl: "xxl";
            }>>;
        }, z.core.$strict>>;
        codeBlock: z.ZodOptional<z.ZodObject<{
            radius: z.ZodOptional<z.ZodEnum<{
                lg: "lg";
                md: "md";
                modalCard: "modalCard";
                sm: "sm";
                xl: "xl";
                xxl: "xxl";
            }>>;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
```


## Referenced declarations owned by other packages

- `@types/react#CSSProperties`
- `@types/react#HTMLElement`
- `@types/react#ReactElement`
- `zod#$ZodTypeInternals`
- `zod#$strict`
- `zod#ZodBoolean`
- `zod#ZodEnum`
- `zod#ZodLiteral`
- `zod#ZodNullable`
- `zod#ZodObject`
- `zod#ZodOptional`
- `zod#ZodRecord`
- `zod#ZodString`
- `zod#ZodType`
- `zod#ZodUnion`
- `zod#output`
