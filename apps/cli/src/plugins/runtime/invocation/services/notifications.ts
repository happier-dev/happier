import { createHash } from 'node:crypto';

import {
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
} from '@happier-dev/protocol';
import {
    isPluginError,
    PluginError,
    type Disposable,
    type JsonValue,
    type PluginApi,
} from '@happier-dev/plugin-sdk';
import {
    type PluginContributionRef } from '@happier-dev/plugin-sdk';
import {
    type NotificationPreferences as PluginNotificationPreferences,
    type NotificationsService as PluginNotificationsService,
} from '@happier-dev/plugin-sdk/notifications';

import type {
    ResolvedNotificationCategoryContribution,
    ResolvedNotificationChannelContribution,
} from '@/plugins/projection/registry/types';
import { clonePluginPlainData } from '@/plugins/runtime/plainData';
import {
    evaluateContributionAvailability,
    resolveInvocationContributionPolicyFacts,
} from '@/plugins/runtime/policy/evaluate';

import type { PluginInvocationServicesSeed } from './types';

const MAX_NOTIFICATION_OPERATIONS = 16_384;
const MAX_CLIENT_REQUEST_ID_CODE_UNITS = 128;
const MAX_NOTIFICATION_TITLE_CODE_UNITS = 512;
const MAX_NOTIFICATION_BODY_CODE_UNITS = 8_000;
const MAX_NOTIFICATION_DATA_BYTES = 64 * 1024;
const MAX_NOTIFICATION_CHANNELS = 32;
const MAX_NOTIFICATION_PAGE_SIZE = 100;
const MAX_NOTIFICATION_CURSOR_CODE_UNITS = 256;
const MAX_NOTIFICATION_RESULT_CODE_UNITS = 128;
const NOTIFICATION_SENDER_RETIRED = Symbol('notification-sender-retired');

export const PLUGIN_NOTIFICATION_IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

type QualifiedRef = Readonly<{ pluginId: string; localId: string }>;
type NotificationContributionReference = NonNullable<
    ResolvedNotificationCategoryContribution['definition']['defaultChannels']
>[number];
type PluginNotificationSender = Parameters<
    PluginApi['notifications']['registerChannel']
>[1];
type PluginNotificationSendRequest = Parameters<PluginNotificationSender>[0];
type PluginNotificationDeliveryResult = Awaited<ReturnType<PluginNotificationSender>>;
type PluginNotificationBatchResult = Awaited<
    ReturnType<PluginNotificationsService['send']>
>;

export type PluginNotificationSenderBinding = Readonly<{
    generation: string;
    isCurrent(): boolean | Promise<boolean>;
    send(request: PluginNotificationSendRequest, signal: AbortSignal): unknown | Promise<unknown>;
}>;

export type StablePluginNotificationsHost = Readonly<{
    categories: readonly NotificationCategoryDeclaration[];
    channels: readonly ResolvedNotificationChannelContribution[];
    activateChannel(ref: PluginContributionRef): Promise<void>;
    readChannel(ref: PluginContributionRef, seed: PluginInvocationServicesSeed): PluginNotificationSenderBinding | null;
    preferencePolicy?: Readonly<{
        read(params: Readonly<{
            pluginId: string;
            categoryId: string;
            eventIds: readonly string[];
            channelId: string;
            channelKind: ResolvedNotificationChannelContribution['definition']['kind'];
        }>): Readonly<{ enabled: boolean; revision: string }>;
        watch(params: Readonly<{
            pluginId: string;
            categoryId: string;
            generation: string;
            listener(): void;
        }>): Disposable;
    }>;
    watchPreferences?(params: Readonly<{
        pluginId: string;
        contributionId: string;
        generation: string;
        categoryId: string;
        listener(preferences: PluginNotificationPreferences): void;
    }>): Disposable;
    now?: () => number;
}>;

type OperationRecord = Readonly<{
    fingerprint: string;
    result: Promise<PluginNotificationBatchResult>;
}>;

function notificationError(code: string, message: string, retryable = false): PluginError {
    return new PluginError({ code, message, ...(retryable ? { retryable: true } : {}) });
}

function localizedFallback(value: string | Readonly<{ fallback: string }>): string {
    return typeof value === 'string' ? value : value.fallback;
}

function resolveRef(ownerPluginId: string, reference: NotificationContributionReference): QualifiedRef {
    return Object.freeze(typeof reference === 'string'
        ? { pluginId: ownerPluginId, localId: reference }
        : { pluginId: reference.pluginId, localId: reference.localId });
}

function qualifiedKey(ref: QualifiedRef): string {
    return buildQualifiedPluginContributionKey(createPluginContributionIdentity(ref));
}

function operationKey(seed: PluginInvocationServicesSeed, categoryId: string, requestId: string): string {
    return `${seed.plugin.id}\u0000${seed.contribution.qualifiedId}\u0000${categoryId}\u0000${requestId}`;
}

function canonicalJson(value: JsonValue): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const record = value as Readonly<Record<string, JsonValue>>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key]!)}`).join(',')}}`;
}

function fingerprint(value: JsonValue): string {
    return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function ensureCurrent(seed: PluginInvocationServicesSeed, signal?: AbortSignal): void {
    if (seed.signal.aborted || signal?.aborted || !seed.isGenerationCurrent()) {
        throw notificationError('plugin_notification_generation_retired', 'Notification invocation generation is no longer current');
    }
}

function notificationWaitAborted(operationIdBound: boolean): PluginError {
    return new PluginError({
        code: 'plugin_notification_wait_aborted',
        message: 'Notification caller wait was aborted',
        details: { operationIdBound },
    });
}

async function waitForOperationResult<T>(result: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return await result;
    if (signal.aborted) throw notificationWaitAborted(true);
    return await new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            reject(notificationWaitAborted(true));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        result.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}

function readPageOptions(options: { cursor?: string; limit?: number; signal?: AbortSignal } | undefined): Readonly<{
    offset: number;
    limit: number;
}> {
    const limit = options?.limit ?? MAX_NOTIFICATION_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_NOTIFICATION_PAGE_SIZE) {
        throw notificationError('plugin_notification_invalid_page', 'Notification page limit is invalid');
    }
    if (options?.cursor === undefined) return { offset: 0, limit };
    if (typeof options.cursor !== 'string' || options.cursor.length > MAX_NOTIFICATION_CURSOR_CODE_UNITS) {
        throw notificationError('plugin_notification_invalid_page', 'Notification page cursor is invalid');
    }
    const match = /^notification:(\d+)$/u.exec(options.cursor);
    if (!match) throw notificationError('plugin_notification_invalid_page', 'Notification page cursor is invalid');
    const offset = Number(match[1]);
    if (!Number.isSafeInteger(offset) || offset < 0) {
        throw notificationError('plugin_notification_invalid_page', 'Notification page cursor is invalid');
    }
    return { offset, limit };
}

function page<T>(items: readonly T[], options?: { cursor?: string; limit?: number }): Readonly<{
    items: readonly T[];
    nextCursor?: string;
}> {
    const { offset, limit } = readPageOptions(options);
    const selected = Object.freeze(items.slice(offset, offset + limit));
    const nextOffset = offset + selected.length;
    return Object.freeze({
        items: selected,
        ...(nextOffset < items.length ? { nextCursor: `notification:${nextOffset}` } : {}),
    });
}

function readChannelIds(value: unknown): readonly string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
        throw notificationError('plugin_notification_invalid_request', 'Notification channel ids are invalid');
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (typeof length !== 'number'
        || !Number.isSafeInteger(length)
        || length < 1
        || length > MAX_NOTIFICATION_CHANNELS) {
        throw notificationError('plugin_notification_invalid_request', 'Notification channel ids are invalid');
    }
    const allowedKeys = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
    if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowedKeys.has(key))) {
        throw notificationError('plugin_notification_invalid_request', 'Notification channel ids must be plain data');
    }
    const result: string[] = [];
    for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'string') {
            throw notificationError('plugin_notification_invalid_request', 'Notification channel ids must be plain strings');
        }
        result.push(descriptor.value);
    }
    return Object.freeze(result);
}

function readRequest(request: Parameters<PluginNotificationsService['send']>[0]): Readonly<{
    clientRequestId: string;
    categoryId: string;
    title: string;
    body?: string;
    channelIds?: readonly string[];
    data?: JsonValue;
}> {
    try {
        if (!request || typeof request !== 'object' || Array.isArray(request)
            || (Object.getPrototypeOf(request) !== Object.prototype && Object.getPrototypeOf(request) !== null)) {
            throw notificationError('plugin_notification_invalid_request', 'Notification request is invalid');
        }
        const allowedKeys = new Set(['clientRequestId', 'categoryId', 'title', 'body', 'channelIds', 'data']);
        const ownKeys = Reflect.ownKeys(request);
        if (ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))) {
            throw notificationError('plugin_notification_invalid_request', 'Notification request contains unknown fields');
        }
        const readField = (key: string): unknown => {
            const descriptor = Object.getOwnPropertyDescriptor(request, key);
            if (!descriptor) return undefined;
            if (!descriptor.enumerable || !('value' in descriptor)) {
                throw notificationError('plugin_notification_invalid_request', 'Notification request fields must be plain data');
            }
            return descriptor.value;
        };
        const clientRequestId = readField('clientRequestId');
        const categoryId = readField('categoryId');
        const title = readField('title');
        const body = readField('body');
        const channelIds = readChannelIds(readField('channelIds'));
        const rawData = readField('data');
        if (typeof clientRequestId !== 'string'
            || clientRequestId.length < 1
            || clientRequestId.length > MAX_CLIENT_REQUEST_ID_CODE_UNITS
            || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(clientRequestId)
            || typeof categoryId !== 'string'
            || typeof title !== 'string'
            || title.length < 1
            || title.length > MAX_NOTIFICATION_TITLE_CODE_UNITS
            || (body !== undefined && (typeof body !== 'string' || body.length > MAX_NOTIFICATION_BODY_CODE_UNITS))
            || (channelIds !== undefined && channelIds.some((id) => typeof id !== 'string'))) {
            throw notificationError('plugin_notification_invalid_request', 'Notification request is invalid');
        }
        const data = rawData === undefined
            ? undefined
            : clonePluginPlainData(rawData, {
                path: 'notification data',
                invalid: (message) => notificationError('plugin_notification_invalid_request', message),
            }) as JsonValue;
        if (data !== undefined && Buffer.byteLength(canonicalJson(data), 'utf8') > MAX_NOTIFICATION_DATA_BYTES) {
            throw notificationError('plugin_notification_invalid_request', 'Notification data exceeds the encoded byte limit');
        }
        return Object.freeze({
            clientRequestId,
            categoryId,
            title,
            ...(body === undefined ? {} : { body }),
            ...(channelIds === undefined ? {} : { channelIds }),
            ...(data === undefined ? {} : { data }),
        });
    } catch (error) {
        if (isPluginError(error)) throw error;
        throw notificationError('plugin_notification_invalid_request', 'Notification request is invalid');
    }
}

function readSenderResult(
    value: unknown,
    deliveryId: string,
    channelId: string,
): PluginNotificationDeliveryResult {
    const outcomeUnknown = (): PluginNotificationDeliveryResult => Object.freeze({
        deliveryId,
        channelId,
        status: 'outcomeUnknown',
        code: 'plugin_notification_outcome_unknown',
    });
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return outcomeUnknown();
    }
    try {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) return outcomeUnknown();
    } catch {
        return outcomeUnknown();
    }
    const allowedKeys = new Set(['deliveryId', 'channelId', 'status', 'evidence', 'code', 'retryable']);
    const fields = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || !allowedKeys.has(key)) return outcomeUnknown();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) return outcomeUnknown();
        fields.set(key, descriptor.value);
    }
    if (fields.get('deliveryId') !== deliveryId || fields.get('channelId') !== channelId) {
        return outcomeUnknown();
    }
    const status = fields.get('status');
    if (status === 'accepted') {
        const evidence = fields.get('evidence');
        return fields.size === 4 && (evidence === 'hostAdapter' || evidence === 'provider' || evidence === 'authoritativeReceipt')
            ? Object.freeze({ deliveryId, channelId, status, evidence })
            : outcomeUnknown();
    }
    if (status === 'outcomeUnknown'
        && fields.size === 4
        && fields.get('code') === 'plugin_notification_outcome_unknown') {
        return Object.freeze({ deliveryId, channelId, status, code: 'plugin_notification_outcome_unknown' });
    }
    const code = fields.get('code');
    if ((status === 'suppressed' || status === 'failed')
        && typeof code === 'string'
        && code.length >= 1
        && code.length <= MAX_NOTIFICATION_RESULT_CODE_UNITS) {
        const retryable = fields.get('retryable');
        if (status === 'suppressed' && fields.size !== 4) return outcomeUnknown();
        if (status === 'failed' && fields.size !== (retryable === undefined ? 4 : 5)) return outcomeUnknown();
        if (status === 'failed' && retryable !== undefined && typeof retryable !== 'boolean') {
            return outcomeUnknown();
        }
        if (status === 'suppressed') {
            return Object.freeze({ deliveryId, channelId, status, code });
        }
        return Object.freeze({
            deliveryId,
            channelId,
            status,
            ...(typeof retryable === 'boolean' ? { retryable } : {}),
            code,
        });
    }
    return outcomeUnknown();
}

async function isSenderBindingCurrent(binding: PluginNotificationSenderBinding): Promise<boolean> {
    try {
        return await binding.isCurrent();
    } catch {
        return false;
    }
}

async function waitForNotificationSender(
    binding: PluginNotificationSenderBinding,
    request: PluginNotificationSendRequest,
    signal: AbortSignal,
): Promise<unknown | typeof NOTIFICATION_SENDER_RETIRED> {
    if (signal.aborted) return NOTIFICATION_SENDER_RETIRED;
    return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (complete: (value: unknown) => void, value: unknown) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', retire);
            complete(value);
        };
        const retire = () => finish(resolve, NOTIFICATION_SENDER_RETIRED);
        signal.addEventListener('abort', retire, { once: true });
        if (signal.aborted) {
            retire();
            return;
        }
        let pending: unknown;
        try {
            pending = binding.send(request, signal);
        } catch (error) {
            finish(reject, error);
            return;
        }
        Promise.resolve(pending).then(
            (value) => finish(resolve, value),
            (error: unknown) => finish(reject, error),
        );
    });
}

export type StablePluginNotificationsOwner = Readonly<{
    bind(
        seed: PluginInvocationServicesSeed,
        options?: Readonly<{
            categories?: readonly NotificationCategoryDeclaration[];
        }>,
    ): PluginNotificationsService;
}>;

export type NotificationCategoryDeclaration = Readonly<Pick<
    ResolvedNotificationCategoryContribution,
    'pluginId' | 'definition'
>>;

export function createStablePluginNotificationsOwner(host: StablePluginNotificationsHost): StablePluginNotificationsOwner {
    const now = host.now ?? Date.now;
    const operations = new Map<string, OperationRecord>();
    const settledAtByResult = new WeakMap<Promise<PluginNotificationBatchResult>, number>();

    function operationExpiry(record: OperationRecord): number | null {
        // Retention begins only after terminal evidence exists. Expiring an
        // in-flight sender would let the same request id dispatch twice.
        const settledAt = settledAtByResult.get(record.result);
        return settledAt === undefined
            ? null
            : settledAt + PLUGIN_NOTIFICATION_IDEMPOTENCY_RETENTION_MS;
    }

    function purgeOperations(timestamp: number): void {
        for (const [key, record] of operations) {
            const expiry = operationExpiry(record);
            if (expiry !== null && timestamp >= expiry) operations.delete(key);
        }
    }

    function capacityRetryAfterMs(timestamp: number): number | null {
        let earliestExpiry = Number.POSITIVE_INFINITY;
        for (const record of operations.values()) {
            const expiry = operationExpiry(record);
            if (expiry !== null) earliestExpiry = Math.min(earliestExpiry, expiry);
        }
        if (!Number.isFinite(earliestExpiry)) return null;
        return Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(earliestExpiry - timestamp)));
    }

    return Object.freeze({
        bind(seed, options) {
            const categories = (options?.categories ?? host.categories)
                .filter((entry) => entry.pluginId === seed.plugin.id)
                .sort((left, right) => left.definition.id.localeCompare(right.definition.id));
            const policyFacts = resolveInvocationContributionPolicyFacts({
                ...(seed.session ? { sessionId: seed.session.id } : {}),
            });
            const readAvailability = (
                contribution: NotificationCategoryDeclaration | ResolvedNotificationChannelContribution,
            ) => evaluateContributionAvailability({
                availability: contribution.definition.availability,
                facts: policyFacts,
            });
            const categoryById = new Map(categories.map((entry) => [entry.definition.id, entry] as const));
            const channelByKey = new Map(host.channels.flatMap((entry) => entry.pluginId
                ? [[qualifiedKey({ pluginId: entry.pluginId, localId: entry.definition.id }), entry] as const]
                : []));
            const referencedChannels = new Map<string, ResolvedNotificationChannelContribution>();
            for (const [key, channel] of channelByKey) {
                if (channel.pluginId === seed.plugin.id) referencedChannels.set(key, channel);
            }
            for (const category of categories) {
                for (const reference of category.definition.defaultChannels ?? []) {
                    const key = qualifiedKey(resolveRef(seed.plugin.id, reference));
                    const channel = channelByKey.get(key);
                    if (channel) referencedChannels.set(key, channel);
                }
            }
            const sortedChannels = [...referencedChannels.entries()].sort(([left], [right]) => left.localeCompare(right));

            const ensureCategory = (categoryId: string) => {
                const category = categoryById.get(categoryId);
                if (!category) {
                    throw notificationError('plugin_notification_category_undeclared', `Notification category '${categoryId}' is not declared by this plugin`);
                }
                const availability = readAvailability(category);
                if (availability.outcome !== 'visible') {
                    throw notificationError(
                        availability.code,
                        `Notification category '${categoryId}' is unavailable under the current contribution policy`,
                    );
                }
                return category;
            };

            const resolveSelectedChannels = (
                category: NotificationCategoryDeclaration,
                requestedIds: readonly string[] | undefined,
            ): readonly Readonly<{ key: string; ref: QualifiedRef; channel: ResolvedNotificationChannelContribution }>[] => {
                const allowed = new Map<string, Readonly<{ key: string; ref: QualifiedRef; channel: ResolvedNotificationChannelContribution }>>();
                for (const [key, channel] of referencedChannels) {
                    if (!channel.pluginId) continue;
                    allowed.set(key, Object.freeze({
                        key,
                        ref: Object.freeze({ pluginId: channel.pluginId, localId: channel.definition.id }),
                        channel,
                    }));
                }
                const defaults = new Map<string, Readonly<{ key: string; ref: QualifiedRef; channel: ResolvedNotificationChannelContribution }>>();
                for (const reference of category.definition.defaultChannels ?? []) {
                    const ref = resolveRef(seed.plugin.id, reference);
                    const key = qualifiedKey(ref);
                    const channel = channelByKey.get(key);
                    if (channel) {
                        const entry = Object.freeze({ key, ref, channel });
                        allowed.set(key, entry);
                        defaults.set(key, entry);
                    }
                }
                if (!requestedIds) return Object.freeze([...defaults.values()]);
                const selected = requestedIds.map((id) => {
                    const exactChannel = allowed.get(id);
                    let key = id;
                    if (!exactChannel) {
                        try {
                            key = qualifiedKey({ pluginId: seed.plugin.id, localId: id });
                        } catch {
                            throw notificationError('plugin_notification_invalid_request', `Notification channel id '${id}' is invalid`);
                        }
                    }
                    const channel = exactChannel ?? allowed.get(key);
                    if (!channel) {
                        throw notificationError('plugin_notification_channel_undeclared', `Notification channel '${id}' is not declared for category '${category.definition.id}'`);
                    }
                    return channel;
                });
                if (new Set(selected.map((entry) => entry.key)).size !== selected.length) {
                    throw notificationError('plugin_notification_invalid_request', 'Notification channel ids must be unique');
                }
                return Object.freeze(selected);
            };
            const readChannelPreference = (
                category: NotificationCategoryDeclaration,
                selectedChannel: Readonly<{
                    key: string;
                    channel: ResolvedNotificationChannelContribution;
                }>,
            ): Readonly<{ enabled: boolean; revision: string }> => {
                const availability = readAvailability(selectedChannel.channel);
                if (availability.outcome !== 'visible') {
                    return Object.freeze({
                        enabled: false,
                        revision: `availability:${availability.outcome}:${availability.code}`,
                    });
                }
                if (selectedChannel.channel.definition.defaultEnabled === false) {
                    return Object.freeze({ enabled: false, revision: 'manifest-disabled' });
                }
                if (!host.preferencePolicy) {
                    return Object.freeze({ enabled: true, revision: 'manifest-enabled' });
                }
                return host.preferencePolicy.read(Object.freeze({
                    pluginId: seed.plugin.id,
                    categoryId: category.definition.id,
                    eventIds: Object.freeze(category.definition.eventIds.map((reference) => (
                        qualifiedKey(resolveRef(seed.plugin.id, reference))
                    ))),
                    channelId: selectedChannel.key,
                    channelKind: selectedChannel.channel.definition.kind,
                }));
            };
            const buildPreferences = (
                category: NotificationCategoryDeclaration,
            ): PluginNotificationPreferences => {
                const selected = resolveSelectedChannels(category, undefined);
                const decisions = selected.map((entry) => Object.freeze({
                    channelId: entry.key,
                    ...readChannelPreference(category, entry),
                }));
                const channelIds = Object.freeze(decisions
                    .filter((decision) => decision.enabled)
                    .map((decision) => decision.channelId));
                return Object.freeze({
                    categoryId: category.definition.id,
                    enabled: channelIds.length > 0,
                    channelIds,
                    revision: fingerprint(Object.freeze({
                        categoryId: category.definition.id,
                        decisions: Object.freeze(decisions),
                    })),
                });
            };

            const send: PluginNotificationsService['send'] = async (rawRequest, options) => {
                ensureCurrent(seed);
                const request = readRequest(rawRequest);
                const category = ensureCategory(request.categoryId);
                const selected = resolveSelectedChannels(category, request.channelIds);
                const normalizedRequest: JsonValue = Object.freeze({
                    clientRequestId: request.clientRequestId,
                    categoryId: request.categoryId,
                    title: request.title,
                    ...(request.body === undefined ? {} : { body: request.body }),
                    channelIds: Object.freeze(selected.map((entry) => entry.key)),
                    ...(request.data === undefined ? {} : { data: request.data }),
                });
                const requestFingerprint = fingerprint(normalizedRequest);
                const key = operationKey(seed, request.categoryId, request.clientRequestId);
                const timestamp = now();
                let existing = operations.get(key);
                if (existing) {
                    const expiry = operationExpiry(existing);
                    if (expiry !== null && timestamp >= expiry) {
                        operations.delete(key);
                        existing = undefined;
                    }
                }
                if (existing) {
                    if (existing.fingerprint !== requestFingerprint) {
                        throw notificationError('plugin_notification_request_conflict', 'Notification request id was already bound to different content');
                    }
                    const result = await waitForOperationResult(existing.result, options?.signal);
                    return Object.freeze({ deliveries: result.deliveries, replayed: true });
                }
                if (options?.signal?.aborted) throw notificationWaitAborted(false);
                if (operations.size >= MAX_NOTIFICATION_OPERATIONS) {
                    purgeOperations(timestamp);
                    if (operations.size >= MAX_NOTIFICATION_OPERATIONS) {
                        const retryAfterMs = capacityRetryAfterMs(timestamp);
                        throw new PluginError({
                            code: 'plugin_notification_capacity_unavailable',
                            message: 'Notification idempotency capacity is unavailable',
                            retryable: true,
                            ...(retryAfterMs === null ? {} : { details: { retryAfterMs } }),
                        });
                    }
                }

                const operationSignal = options?.signal
                    ? AbortSignal.any([seed.signal, options.signal])
                    : seed.signal;
                const result = (async (): Promise<PluginNotificationBatchResult> => {
                    const deliveries: PluginNotificationDeliveryResult[] = [];
                    for (const selectedChannel of selected) {
                        const deliveryId = `notification_${fingerprint(`${key}\u0000${selectedChannel.key}`)}`;
                        const availability = readAvailability(selectedChannel.channel);
                        if (availability.outcome !== 'visible') {
                            deliveries.push(Object.freeze(availability.outcome === 'unavailable'
                                ? {
                                    deliveryId,
                                    channelId: selectedChannel.key,
                                    status: 'failed' as const,
                                    code: availability.code,
                                    retryable: false,
                                }
                                : {
                                    deliveryId,
                                    channelId: selectedChannel.key,
                                    status: 'suppressed' as const,
                                    code: availability.code,
                                }));
                            continue;
                        }
                        if (!readChannelPreference(category, selectedChannel).enabled) {
                            deliveries.push(Object.freeze({
                                deliveryId, channelId: selectedChannel.key, status: 'suppressed', code: 'plugin_notification_channel_disabled',
                            }));
                            continue;
                        }
                        if (seed.signal.aborted || !seed.isGenerationCurrent()) {
                            deliveries.push(Object.freeze({
                                deliveryId, channelId: selectedChannel.key, status: 'failed', code: 'plugin_notification_generation_retired', retryable: false,
                            }));
                            continue;
                        }
                        try {
                            await host.activateChannel(selectedChannel.ref);
                        } catch {
                            deliveries.push(Object.freeze({
                                deliveryId, channelId: selectedChannel.key, status: 'failed', code: 'plugin_notification_channel_unavailable', retryable: true,
                            }));
                            continue;
                        }
                        if (seed.signal.aborted || !seed.isGenerationCurrent()) {
                            deliveries.push(Object.freeze({
                                deliveryId, channelId: selectedChannel.key, status: 'failed', code: 'plugin_notification_generation_retired', retryable: false,
                            }));
                            continue;
                        }
                        const binding = host.readChannel(selectedChannel.ref, seed);
                        if (!binding
                            || binding.generation !== seed.generation
                            || !await isSenderBindingCurrent(binding)) {
                            deliveries.push(Object.freeze({
                                deliveryId, channelId: selectedChannel.key, status: 'failed', code: 'plugin_notification_channel_unavailable', retryable: true,
                            }));
                            continue;
                        }
                        const senderRequest: PluginNotificationSendRequest = Object.freeze({
                            clientRequestId: request.clientRequestId,
                            deliveryId,
                            categoryId: qualifiedKey({ pluginId: seed.plugin.id, localId: request.categoryId }),
                            channelId: selectedChannel.key,
                            title: request.title,
                            ...(request.body === undefined ? {} : { body: request.body }),
                            ...(request.data === undefined ? {} : { data: request.data }),
                        });
                        try {
                            const senderResult = await waitForNotificationSender(binding, senderRequest, operationSignal);
                            if (senderResult === NOTIFICATION_SENDER_RETIRED
                                || operationSignal.aborted
                                || !seed.isGenerationCurrent()
                                || !await isSenderBindingCurrent(binding)) {
                                deliveries.push(Object.freeze({
                                    deliveryId, channelId: selectedChannel.key, status: 'outcomeUnknown', code: 'plugin_notification_outcome_unknown',
                                }));
                            } else {
                                deliveries.push(readSenderResult(senderResult, deliveryId, selectedChannel.key));
                            }
                        } catch {
                            deliveries.push(Object.freeze({
                                deliveryId, channelId: selectedChannel.key, status: 'outcomeUnknown', code: 'plugin_notification_outcome_unknown',
                            }));
                        }
                    }
                    return Object.freeze({ deliveries: Object.freeze(deliveries), replayed: false });
                })();
                operations.set(key, Object.freeze({ fingerprint: requestFingerprint, result }));
                void result.then(
                    () => settledAtByResult.set(result, now()),
                    () => settledAtByResult.set(result, now()),
                );
                return await waitForOperationResult(result, options?.signal);
            };

            const listChannels: PluginNotificationsService['listChannels'] = async (options) => {
                ensureCurrent(seed, options?.signal);
                const { offset, limit } = readPageOptions(options);
                const selected = sortedChannels.slice(offset, offset + limit);
                const items = [];
                for (const [id, channel] of selected) {
                    const summary = {
                        id,
                        title: localizedFallback(channel.definition.title),
                    };
                    const availability = readAvailability(channel);
                    if (availability.outcome !== 'visible') {
                        items.push(Object.freeze({
                            ...summary,
                            state: 'unavailable' as const,
                            code: availability.code,
                        }));
                        continue;
                    }
                    if (channel.definition.defaultEnabled === false || !channel.pluginId) {
                        items.push(Object.freeze({
                            ...summary,
                            state: 'unavailable' as const,
                            code: 'plugin_notification_channel_disabled',
                        }));
                        continue;
                    }
                    const ref = Object.freeze({ pluginId: channel.pluginId, localId: channel.definition.id });
                    try {
                        await host.activateChannel(ref);
                        ensureCurrent(seed, options?.signal);
                        const binding = host.readChannel(ref, seed);
                        items.push(Object.freeze(binding
                            && binding.generation === seed.generation
                            && await isSenderBindingCurrent(binding)
                            ? { ...summary, state: 'available' as const }
                            : { ...summary, state: 'unavailable' as const, code: 'plugin_notification_channel_unavailable' }));
                    } catch (error) {
                        ensureCurrent(seed, options?.signal);
                        items.push(Object.freeze({
                            ...summary,
                            state: 'unavailable' as const,
                            code: 'plugin_notification_channel_unavailable',
                        }));
                    }
                }
                const nextOffset = offset + items.length;
                return Object.freeze({
                    items: Object.freeze(items),
                    ...(nextOffset < sortedChannels.length ? { nextCursor: `notification:${nextOffset}` } : {}),
                });
            };
            const listCategories: PluginNotificationsService['listCategories'] = async (options) => {
                ensureCurrent(seed, options?.signal);
                return page(categories
                    .filter((entry) => readAvailability(entry).outcome === 'visible')
                    .map((entry) => Object.freeze({
                        id: entry.definition.id,
                        title: localizedFallback(entry.definition.title),
                        ...(entry.definition.description === undefined ? {} : { description: localizedFallback(entry.definition.description) }),
                        defaultChannelIds: Object.freeze([...new Set(
                            (entry.definition.defaultChannels ?? []).map((reference) => (
                                qualifiedKey(resolveRef(seed.plugin.id, reference))
                            )),
                        )]),
                    })), options);
            };
            const preferences: PluginNotificationsService['preferences'] = async (categoryId, options) => {
                ensureCurrent(seed, options?.signal);
                const category = ensureCategory(categoryId);
                return buildPreferences(category);
            };
            const watchPreferences: PluginNotificationsService['watchPreferences'] = (categoryId, listener): Disposable => {
                ensureCurrent(seed);
                const category = ensureCategory(categoryId);
                if (typeof listener !== 'function') {
                    throw notificationError('plugin_notification_invalid_listener', 'Notification preference listener is invalid');
                }
                if (!host.preferencePolicy && !host.watchPreferences) {
                    throw notificationError(
                        'plugin_notification_preferences_watch_unavailable',
                        'Notification preference watch is unavailable',
                    );
                }
                let disposed = false;
                let hostWatch: Disposable | null = null;
                const dispose = () => {
                    if (disposed) return;
                    disposed = true;
                    seed.signal.removeEventListener('abort', dispose);
                    hostWatch?.dispose();
                };
                try {
                    const publish = (preferences: PluginNotificationPreferences) => {
                        if (!disposed && !seed.signal.aborted && seed.isGenerationCurrent()) listener(preferences);
                    };
                    const candidate = host.preferencePolicy
                        ? host.preferencePolicy.watch(Object.freeze({
                            pluginId: seed.plugin.id,
                            generation: seed.generation,
                            categoryId,
                            listener: () => publish(buildPreferences(category)),
                        }))
                        : host.watchPreferences!(Object.freeze({
                            pluginId: seed.plugin.id,
                            contributionId: seed.contribution.qualifiedId,
                            generation: seed.generation,
                            categoryId,
                            listener: publish,
                        }));
                    if (!candidate || typeof candidate.dispose !== 'function') {
                        throw new TypeError('Notification preference watch returned an invalid disposable');
                    }
                    hostWatch = candidate;
                } catch {
                    throw notificationError(
                        'plugin_notification_preferences_watch_unavailable',
                        'Notification preference watch is unavailable',
                    );
                }
                seed.signal.addEventListener('abort', dispose, { once: true });
                if (seed.signal.aborted || !seed.isGenerationCurrent()) dispose();
                return Object.freeze({ dispose });
            };

            return Object.freeze({
                send,
                listChannels,
                listCategories,
                preferences,
                watchPreferences,
            });
        },
    });
}

export function createStablePluginNotificationsService(
    seed: PluginInvocationServicesSeed,
    host: StablePluginNotificationsHost,
): PluginNotificationsService {
    return createStablePluginNotificationsOwner(host).bind(seed);
}
