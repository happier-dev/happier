export type JsonPrimitive = null | boolean | number | string;

export type JsonValue =
    | JsonPrimitive
    | readonly JsonValue[]
    | { readonly [key: string]: JsonValue };

export type PluginJsonSchema = JsonValue;

export type PluginContributionRef = Readonly<{
    pluginId: string;
    localId: string;
}>;

export type PluginReference = string | PluginContributionRef;

export type PluginIdentity = Readonly<{
    id: string;
    version: string;
}>;

export type PluginInvocationContributionIdentity = Readonly<{
    id: string;
    qualifiedId: string;
}>;
