import * as React from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { getActionSpec, resolveEffectiveActionInputFields } from '@happier-dev/protocol';

import { storage, useSession } from '@/sync/domains/state/storage';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { useExecutionRunsBackendsForSession } from '@/hooks/server/useExecutionRunsBackendsForSession';
import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { t } from '@/text';
import type { SessionActionDraft } from '@/sync/domains/sessionActions/sessionActionDraftTypes';
import { buildAvailableReviewEngineOptions } from '@/sync/domains/reviews/reviewEngineCatalog';
import { layout } from '@/components/ui/layout/layout';

type EngineOption = Readonly<{ id: string; label: string; disabled?: boolean }>;

function getValueAtPath(input: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.').filter(Boolean);
  let cur: any = input;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function setValueAtTopLevelPatch(input: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) return {};
  const top = parts[0]!;
  if (parts.length === 1) return { [top]: value };

  const rest = parts.slice(1);
  const prevTop: any = (input as any)[top];
  const nextTop = (() => {
    const base = prevTop && typeof prevTop === 'object' ? { ...(prevTop as any) } : {};
    let cur: any = base;
    for (let i = 0; i < rest.length; i++) {
      const key = rest[i]!;
      if (i === rest.length - 1) {
        cur[key] = value;
      } else {
        const existing = cur[key];
        cur[key] = existing && typeof existing === 'object' ? { ...(existing as any) } : {};
        cur = cur[key];
      }
    }
    return base;
  })();
  return { [top]: nextTop };
}

function useReviewEngineOptions(sessionId: string): readonly EngineOption[] {
  const enabledAgentIds = useEnabledAgentIds();
  const backends = useExecutionRunsBackendsForSession(sessionId);

  return React.useMemo(() => {
    const opts = buildAvailableReviewEngineOptions({
      enabledAgentIds,
      executionRunsBackends: backends,
      resolveAgentLabel: (id) => t(getAgentCore(id as AgentId).displayNameKey),
    });
    return opts;
  }, [backends, enabledAgentIds]);
}

function useExecutionBackendOptions(): readonly EngineOption[] {
  const enabledAgentIds = useEnabledAgentIds();
  return React.useMemo(
    () =>
      enabledAgentIds.map((id) => ({
        id,
        label: t(getAgentCore(id as AgentId).displayNameKey),
      })),
    [enabledAgentIds],
  );
}

function Chip(props: Readonly<{ selected: boolean; label: string; onPress: () => void; disabled?: boolean }>) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected, disabled: props.disabled === true }}
      onPress={props.disabled ? undefined : props.onPress}
      style={({ pressed }) => ({
        paddingVertical: 8,
        paddingHorizontal: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        opacity: props.disabled ? 0.4 : pressed ? 0.7 : 1,
        backgroundColor: props.selected ? 'rgba(0,0,0,0.06)' : 'transparent',
      })}
    >
      <Text style={{ color: theme.colors.text }}>{props.label}</Text>
    </Pressable>
  );
}

export function SessionActionDraftCard(props: Readonly<{ sessionId: string; draft: SessionActionDraft }>) {
  const { theme } = useUnistyles();
  const spec = getActionSpec(props.draft.actionId as any);
  const executor = React.useMemo(
    () => createDefaultActionExecutor({ resolveServerIdForSessionId: resolveServerIdForSessionIdFromLocalCache }),
    [],
  );

  const input: Record<string, unknown> = props.draft.input ?? {};
  const engineOptions = useReviewEngineOptions(props.sessionId);
  const backendOptions = useExecutionBackendOptions();

  const resolveFieldOptions = React.useCallback(
    (field: any): ReadonlyArray<Readonly<{ value: string; label: string }>> => {
      const sourceId = typeof field?.optionsSourceId === 'string' ? field.optionsSourceId : '';
      if (sourceId === 'review.engines.available') {
        return engineOptions.map((o) => ({ value: o.id, label: o.label }));
      }
      if (sourceId === 'execution.backends.enabled') {
        return backendOptions.map((o) => ({ value: o.id, label: o.label }));
      }
      const opts = Array.isArray(field?.options) ? field.options : [];
      return opts
        .map((o: any) => {
          const value = typeof o?.value === 'string' ? o.value : '';
          const label = typeof o?.label === 'string' ? o.label : value;
          if (!value) return null;
          return { value, label };
        })
        .filter(Boolean) as any;
    },
    [backendOptions, engineOptions],
  );

  const setInputPatch = React.useCallback(
    (patch: Record<string, unknown>) => {
      storage.getState().updateSessionActionDraftInput(props.sessionId, props.draft.id, patch);
    },
    [props.draft.id, props.sessionId],
  );

  const setStatus = React.useCallback(
    (status: 'editing' | 'running' | 'succeeded' | 'failed', error?: string | null) => {
      storage.getState().setSessionActionDraftStatus(props.sessionId, props.draft.id, status as any, error);
    },
    [props.draft.id, props.sessionId],
  );

  const cancel = React.useCallback(() => {
    storage.getState().deleteSessionActionDraft(props.sessionId, props.draft.id);
  }, [props.draft.id, props.sessionId]);

  const validate = React.useCallback((): string | null => {
    const parsed = (spec.inputSchema as any).safeParse({
      sessionId: props.sessionId,
      ...(props.draft.input ?? {}),
    });
    if (parsed.success) return null;
    const first = Array.isArray(parsed.error?.issues) ? parsed.error.issues[0] : null;
    return typeof first?.message === 'string' && first.message.trim() ? first.message.trim() : 'Invalid input';
  }, [props.draft.input, props.sessionId, spec.inputSchema]);

  const submit = React.useCallback(async () => {
    const err = validate();
    if (err) {
      setStatus('editing', err);
      return;
    }

    setStatus('running', null);
    try {
      const res = await executor.execute(
        props.draft.actionId as any,
        {
          sessionId: props.sessionId,
          ...(props.draft.input ?? {}),
        },
        { defaultSessionId: props.sessionId },
      );
      if (!res.ok) {
        setStatus('failed', res.error ?? 'Failed to start');
        return;
      }
      const inner: any = res.result;
      const results: any[] = Array.isArray(inner?.results) ? inner.results : [];
      if (results.some((r) => r && r.ok === false)) {
        const first = results.find((r) => r && r.ok === false);
        setStatus('failed', String(first?.error ?? 'Failed to start'));
        return;
      }
      setStatus('succeeded', null);
      // Action drafts are ephemeral UI affordances. Once the action has been dispatched
      // successfully, remove the draft card so the transcript doesn't stay cluttered.
      cancel();
    } catch (e) {
      setStatus('failed', e instanceof Error ? e.message : 'Failed to start');
    }
  }, [cancel, executor, input, props.draft.actionId, props.draft.input, props.sessionId, setStatus, validate]);

  const title = spec.title;
  const error = props.draft.error ? String(props.draft.error) : '';

  const fields = React.useMemo(() => {
    return resolveEffectiveActionInputFields(spec as any, { sessionId: props.sessionId, ...(props.draft.input ?? {}) });
  }, [props.draft.input, props.sessionId, spec]);

  return (
    <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
      <View style={{ width: '100%', maxWidth: layout.maxWidth, paddingHorizontal: 16 }}>
        <View
          style={{
            marginVertical: 8,
            padding: 12,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: theme.colors.divider,
            backgroundColor: theme.colors.surface,
          }}
        >
          <Text style={{ color: theme.colors.text, fontWeight: '600', marginBottom: 8 }}>{title}</Text>

          {fields.length > 0 ? (
            fields.map((field: any) => {
              const path = typeof field?.path === 'string' ? field.path : '';
              const widget = typeof field?.widget === 'string' ? field.widget : '';
              if (!path || !widget) return null;

              const label = typeof field?.title === 'string' ? field.title : path;
              const value = getValueAtPath(input, path);
              const editable = props.draft.status === 'editing';
              const disabled = (field as any)?.disabled === true;

              if (widget === 'multiselect') {
                const selected = Array.isArray(value) ? (value as unknown[]).map(String) : [];
                const options = resolveFieldOptions(field);
                return (
                  <View key={path} style={{ marginTop: 10 }}>
                    <Text style={{ color: theme.colors.textSecondary, marginBottom: 6 }}>{label}</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                      {options.map((opt) => {
                        const isSelected = selected.includes(opt.value);
                        return (
                          <Chip
                            key={opt.value}
                            label={opt.label}
                            selected={isSelected}
                            disabled={!editable || disabled}
                            onPress={() => {
                              if (!editable || disabled) return;
                              const next = isSelected ? selected.filter((id) => id !== opt.value) : [...selected, opt.value];
                              setInputPatch(setValueAtTopLevelPatch(input, path, next));
                            }}
                          />
                        );
                      })}
                    </View>
                  </View>
                );
              }

              if (widget === 'select') {
                const selected = typeof value === 'string' ? value : '';
                const options = resolveFieldOptions(field);
                return (
                  <View key={path} style={{ marginTop: 10 }}>
                    <Text style={{ color: theme.colors.textSecondary, marginBottom: 6 }}>{label}</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                      {options.map((opt) => (
                        <Chip
                          key={opt.value}
                          label={opt.label}
                          selected={selected === opt.value}
                          disabled={!editable || disabled}
                          onPress={() => {
                            if (!editable || disabled) return;
                            setInputPatch(setValueAtTopLevelPatch(input, path, opt.value));
                          }}
                        />
                      ))}
                    </View>
                  </View>
                );
              }

              if (widget === 'toggle' || widget === 'checkbox') {
                const selected = value === true;
                return (
                  <View key={path} style={{ marginTop: 10 }}>
                    <Text style={{ color: theme.colors.textSecondary, marginBottom: 6 }}>{label}</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                      <Chip
                        label="On"
                        selected={selected}
                        disabled={!editable || disabled}
                        onPress={() => {
                          if (!editable || disabled) return;
                          setInputPatch(setValueAtTopLevelPatch(input, path, true));
                        }}
                      />
                      <Chip
                        label="Off"
                        selected={!selected}
                        disabled={!editable || disabled}
                        onPress={() => {
                          if (!editable || disabled) return;
                          setInputPatch(setValueAtTopLevelPatch(input, path, false));
                        }}
                      />
                    </View>
                  </View>
                );
              }

              if (widget === 'text_list') {
                const sep = field?.listSeparator === 'newline' ? '\n' : ',';
                const arr = Array.isArray(value) ? (value as unknown[]).map((v) => String(v ?? '').trim()).filter(Boolean) : [];
                const str = sep === '\n' ? arr.join('\n') : arr.join(', ');
                return (
                  <View key={path} style={{ marginTop: 10 }}>
                    <Text style={{ color: theme.colors.textSecondary, marginBottom: 6 }}>{label}</Text>
                    <TextInput
                      editable={editable && !disabled}
                      value={str}
                      onChangeText={(text) => {
                        const parts = sep === '\n'
                          ? String(text ?? '').split('\n')
                          : String(text ?? '').split(',');
                        const next = parts.map((p) => p.trim()).filter((p) => p.length > 0);
                        setInputPatch(setValueAtTopLevelPatch(input, path, next));
                      }}
                      multiline={field?.listSeparator === 'newline'}
                      placeholderTextColor={theme.colors.textSecondary}
                      style={{
                        borderWidth: 1,
                        borderColor: theme.colors.divider,
                        borderRadius: 10,
                        padding: 10,
                        ...(field?.listSeparator === 'newline' ? { minHeight: 80 } : {}),
                        color: theme.colors.text,
                      }}
                    />
                  </View>
                );
              }

              if (widget === 'textarea' || widget === 'text') {
                const str = typeof value === 'string' ? value : '';
                const multiline = widget === 'textarea';
                return (
                  <View key={path} style={{ marginTop: 10 }}>
                    <Text style={{ color: theme.colors.textSecondary, marginBottom: 6 }}>{label}</Text>
                    <TextInput
                      editable={editable && !disabled}
                      value={str}
                      onChangeText={(text) => setInputPatch(setValueAtTopLevelPatch(input, path, text))}
                      multiline={multiline}
                      placeholderTextColor={theme.colors.textSecondary}
                      style={{
                        borderWidth: 1,
                        borderColor: theme.colors.divider,
                        borderRadius: 10,
                        padding: 10,
                        ...(multiline ? { minHeight: 80 } : {}),
                        color: theme.colors.text,
                      }}
                    />
                  </View>
                );
              }

              return null;
            })
          ) : (
            <Text style={{ color: theme.colors.textSecondary }}>This action has no input hints.</Text>
          )}

          {error ? (
            <Text style={{ color: theme.colors.status.error, marginTop: 10 }}>{error}</Text>
          ) : null}

          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 12 }}>
            <Pressable
              accessibilityRole="button"
              onPress={cancel}
              disabled={props.draft.status === 'running'}
              style={({ pressed }) => ({
                paddingVertical: 10,
                paddingHorizontal: 12,
                borderRadius: 10,
                opacity: props.draft.status === 'running' ? 0.4 : pressed ? 0.7 : 1,
              })}
            >
              <Text style={{ color: theme.colors.textSecondary }}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => void submit()}
              disabled={props.draft.status !== 'editing'}
              style={({ pressed }) => ({
                paddingVertical: 10,
                paddingHorizontal: 12,
                borderRadius: 10,
                backgroundColor: theme.colors.button.primary.background,
                opacity: props.draft.status !== 'editing' ? 0.5 : pressed ? 0.8 : 1,
              })}
            >
              <Text style={{ color: theme.colors.button.primary.tint, fontWeight: '600' }}>Start</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}
