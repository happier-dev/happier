// Explicit compiler-only drift gate; excluded from prerequisite dependency builds.
// Each generated family and public support root is verified against its canonical owner.
import type { PluginActionInputById as SchemaInputs, PluginActionResultById as SchemaResults } from './actionSpecs.js';
import type { PluginActionInputById as DtoInputs, PluginActionResultById as DtoResults } from '../../../plugin-sdk/src/actions/actionTypeMap.generated.js';
import type { PluginDeclarativeNodeV2 as CanonicalDeclarativeNode } from '../plugins/contributions/ui/v2.js';
import type { PluginDeclarativeNodeV2 as DeclarativeNodeDto, PluginUiIconTokenV1 as IconDto } from '../../../plugin-sdk/src/actions/dtos/actionDeclarativeNodeDto.generated.js';
import type { PLUGIN_UI_ICON_TOKENS_V1 } from '../plugins/contributions/ui/tokens.js';
import type * as CanonicalAction from './actionSpecs.js';
import type * as CanonicalHints from './actionInputHintsRuntime.js';
import type * as DtoSupport from '../../../plugin-sdk/src/actions/dtos/pluginActionDtoSupport.generated.js';
import type * as CanonicalExternalLinks from '../plugins/contributions/agentExternalSessions.js';
import type { ActionInputPredicate as CanonicalPredicate } from './actionInputPredicates.js';
import type { PluginMachineExecutionOriginV1 as CanonicalOrigin } from '../machines/administration/pluginMachineExecutionOriginV1.js';
import type { ActionId, RuntimeActionIdV1 } from './actionIds.js';
import type { RUNTIME_ACTION_INPUT_SCHEMAS, RUNTIME_ACTION_OUTPUT_SCHEMAS } from './specs/index.js';
import type { ACTION_ID_FAMILIES_V1 } from './actionIds.js';

    import type { z } from '../zodRuntimePolicy.js';
    import type { JsonValue } from '../json/strictJsonValue.js';
    import type { PluginJsonValueV2 } from '../plugins/contributions/jsonSchema.js';
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
      ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false : false;
    type PublicScalar<T> = T extends string ? T extends z.core.$brand<string> ? string : T : T;
    type PublicValue<T, Input extends boolean> = [T] extends [never] ? never
      : [T] extends [string | number | boolean | null | undefined]
      ? PublicScalar<T>
      : Equal<T, JsonValue> extends true
      ? JsonValue
      : Equal<T, PluginJsonValueV2> extends true ? Input extends true ? JsonValue : PluginJsonValueV2
      : T extends z.ZodMiniType ? unknown
        : T extends string ? T extends z.core.$brand<string> ? string : T
          : T extends (...args: never[]) => unknown ? T
            : T extends object ? { [K in keyof T]: PublicValue<T[K], Input> } : T;
    type Concrete<T> = [T] extends [never] ? false : 0 extends (1 & T) ? false : unknown extends T ? false : true;
    type Failures<Schema, Dto, Input extends boolean> = {
      [K in keyof Dto]: K extends keyof Schema
        ? Concrete<Dto[K]> extends true
          ? Concrete<Schema[K]> extends true
            ? [PublicValue<Schema[K], Input>] extends [Dto[K]]
              ? [Dto[K]] extends [PublicValue<Schema[K], Input>] ? never : K
              : K
            : K
          : K
        : K;
    }[keyof Dto];
  
type AssertTrue<T extends true> = T;
type AssertNever<T extends never> = T;
// Check each executable carrier independently. Comparing the complete maps in
// prerequisite compilation exceeds the checker depth as the catalog grows.
type ExactFailures<Actual, Expected> = {
  [K in keyof Expected]: K extends keyof Actual
    ? Concrete<Actual[K]> extends true
      ? Concrete<Expected[K]> extends true
        ? Equal<Actual[K], Expected[K]> extends true ? never : K
        : K
      : K
    : K;
}[keyof Expected];
type PluginRuntimeInputs = {
  [K in keyof typeof CanonicalAction.PLUGIN_ACTION_INPUT_SCHEMAS]: z.input<(typeof CanonicalAction.PLUGIN_ACTION_INPUT_SCHEMAS)[K]>;
};
type PluginRuntimeResults = {
  [K in keyof typeof CanonicalAction.PLUGIN_ACTION_OUTPUT_SCHEMAS]: z.output<(typeof CanonicalAction.PLUGIN_ACTION_OUTPUT_SCHEMAS)[K]>;
};
type PublicRuntimeInputs = {
  [K in keyof typeof CanonicalAction.PUBLIC_ACTION_INPUT_SCHEMAS]: z.input<(typeof CanonicalAction.PUBLIC_ACTION_INPUT_SCHEMAS)[K]>;
};
type PublicRuntimeResults = {
  [K in keyof typeof CanonicalAction.PUBLIC_ACTION_OUTPUT_SCHEMAS]: z.output<(typeof CanonicalAction.PUBLIC_ACTION_OUTPUT_SCHEMAS)[K]>;
};
type CanonicalRuntimeInputs = {
  [K in RuntimeActionIdV1]: Extract<CanonicalAction.CanonicalActionSpecDefinition, { readonly id: K }>['inputSchema'];
};
type CanonicalRuntimeResults = {
  [K in RuntimeActionIdV1]: Extract<CanonicalAction.CanonicalActionSpecDefinition, { readonly id: K }>['outputSchema'];
};
type CanonicalActionIdsMustCoverRegistry = AssertTrue<Equal<CanonicalAction.CanonicalActionSpecDefinition['id'], ActionId>>;
type CanonicalRuntimeInputsMustMatchOwner = AssertNever<ExactFailures<CanonicalRuntimeInputs, typeof RUNTIME_ACTION_INPUT_SCHEMAS>>;
type CanonicalRuntimeResultsMustMatchOwner = AssertNever<ExactFailures<CanonicalRuntimeResults, typeof RUNTIME_ACTION_OUTPUT_SCHEMAS>>;
type PluginRuntimeInputsMustRemainExact = AssertNever<ExactFailures<PluginRuntimeInputs, SchemaInputs>>;
type ConversationPrUpdateRuntimeMustRemainJson = AssertTrue<Equal<PluginRuntimeInputs['automation.conversation.admit']['prUpdate'], JsonValue | undefined>>;
type ConversationPrUpdateDtoMustRemainJson = AssertTrue<Equal<DtoInputs['automation.conversation.admit']['prUpdate'], JsonValue | undefined>>;
type PluginRuntimeResultsMustRemainExact = AssertNever<ExactFailures<PluginRuntimeResults, SchemaResults>>;
type PublicRuntimeInputsMustRemainExact = AssertNever<ExactFailures<PublicRuntimeInputs, CanonicalAction.PublicActionInputById>>;
type PublicRuntimeResultsMustRemainExact = AssertNever<ExactFailures<PublicRuntimeResults, CanonicalAction.PublicActionResultById>>;
type PluginInputRuntimeKeysMustRemainExact = AssertTrue<Equal<keyof PluginRuntimeInputs, keyof SchemaInputs>>;
type PluginResultRuntimeKeysMustRemainExact = AssertTrue<Equal<keyof PluginRuntimeResults, keyof SchemaResults>>;
type PublicInputRuntimeKeysMustRemainExact = AssertTrue<Equal<keyof PublicRuntimeInputs, keyof CanonicalAction.PublicActionInputById>>;
type PublicResultRuntimeKeysMustRemainExact = AssertTrue<Equal<keyof PublicRuntimeResults, keyof CanonicalAction.PublicActionResultById>>;
type ClipboardActionId = Extract<ActionId, `computer.clipboard.${string}`>;
type ClipboardPublicIds = AssertTrue<Equal<Extract<CanonicalAction.PublicActionId, ClipboardActionId>, ClipboardActionId>>;
type ClipboardPublicInputs = AssertTrue<Equal<Extract<keyof CanonicalAction.PublicActionInputById, ClipboardActionId>, ClipboardActionId>>;
type ClipboardPublicResults = AssertTrue<Equal<Extract<keyof CanonicalAction.PublicActionResultById, ClipboardActionId>, ClipboardActionId>>;
type ClipboardPluginInputs = AssertTrue<Equal<Extract<keyof DtoInputs, ClipboardActionId>, ClipboardActionId>>;
type ClipboardPluginResults = AssertTrue<Equal<Extract<keyof DtoResults, ClipboardActionId>, ClipboardActionId>>;
type PluginSessionTranscriptInputMustRemainExternalShareable = AssertTrue<Equal<SchemaInputs['session.transcript.get'], CanonicalAction.SessionTranscriptGetExternalShareableInputV1>>;
type PluginSessionTranscriptResultMustRemainExternalShareable = AssertTrue<Equal<SchemaResults['session.transcript.get'], CanonicalAction.SessionTranscriptGetExternalShareableResultV1>>;
type PluginRawSessionReadersMustRemainAvailable = AssertTrue<Equal<Extract<keyof SchemaInputs, 'session.history.get' | 'session.events.get' | 'session.messages.recent.get'>, 'session.history.get' | 'session.events.get' | 'session.messages.recent.get'>>;
// Runtime projection delegates consume these same public support declarations.
// Their correspondence belongs here, never in the SDK's prerequisite build.
type CanonicalSupport = {
  spec: CanonicalAction.ActionSpec & { readonly id: keyof SchemaInputs };
  hints: CanonicalAction.ActionInputHints;
  field: CanonicalAction.ActionInputFieldHint;
  option: CanonicalAction.ActionInputOption;
  optionValue: CanonicalHints.ActionInputOptionValue;
  effectiveField: CanonicalHints.EffectiveActionInputField;
  predicate: CanonicalPredicate;
  executionOrigin: CanonicalOrigin;
  linkArray: CanonicalExternalLinks.PluginAgentExternalSessionLinkDataArray;
  linkObject: CanonicalExternalLinks.PluginAgentExternalSessionLinkDataObject;
  linkValue: CanonicalExternalLinks.PluginAgentExternalSessionLinkDataValue;
};
type PublicSupport = {
  spec: DtoSupport.ActionSpec;
  hints: DtoSupport.ActionInputHints;
  field: DtoSupport.ActionInputFieldHint;
  option: DtoSupport.ActionInputOption;
  optionValue: DtoSupport.ActionInputOptionValue;
  effectiveField: DtoSupport.EffectiveActionInputField;
  predicate: DtoSupport.ActionInputPredicate;
  executionOrigin: DtoSupport.PluginMachineExecutionOriginV1;
  linkArray: DtoSupport.PluginAgentExternalSessionLinkDataArray;
  linkObject: DtoSupport.PluginAgentExternalSessionLinkDataObject;
  linkValue: DtoSupport.PluginAgentExternalSessionLinkDataValue;
};
type SupportMustCorrespond = AssertNever<Failures<CanonicalSupport, PublicSupport, false>>;
type IconVocabularyMustCorrespond = AssertTrue<Equal<(typeof PLUGIN_UI_ICON_TOKENS_V1)[number], IconDto>>;
type DeclarativeNodeMustCorrespond = AssertNever<Failures<{ node: CanonicalDeclarativeNode }, { node: DeclarativeNodeDto }, false>>;
type InputKeysMustRemainExact = AssertTrue<Equal<keyof SchemaInputs, keyof DtoInputs>>;
// Bidirectional assignability alone does not detect a missing optional selector.
type ClientChoiceDtoSelectorsMustRemainOptional = AssertTrue<Equal<
  { [K in 'session.open' | 'settings.get' | 'action.invoke']: Pick<DtoInputs[K], 'clientId'> },
  { [K in 'session.open' | 'settings.get' | 'action.invoke']: { clientId?: string } }
>>;
type ResultKeysMustRemainExact = AssertTrue<Equal<keyof SchemaResults, keyof DtoResults>>;

// Canonical family membership partitions the exact aggregate without a second
// handwritten family census. Newly added families enter this same proof.
type ActionFamilies = typeof ACTION_ID_FAMILIES_V1;
type FamilyCorrespondenceFailures<Schema, Dto, Input extends boolean> = {
  [F in keyof ActionFamilies]: Failures<Schema, Pick<Dto, Extract<ActionFamilies[F][number], keyof Dto>>, Input>;
}[keyof ActionFamilies];
type CheckedFamilyIdsMustCoverIndex = AssertTrue<Equal<
  Extract<ActionFamilies[keyof ActionFamilies][number], keyof SchemaInputs>,
  keyof DtoInputs
>>;
type InputFamiliesMustCorrespond = AssertNever<FamilyCorrespondenceFailures<SchemaInputs, DtoInputs, true>>;
type ResultFamiliesMustCorrespond = AssertNever<FamilyCorrespondenceFailures<SchemaResults, DtoResults, false>>;

// Edit consumers share the canonical op grammar, including its input type.
// A validator's default `unknown` input must not erase the entire union in DTOs.
// A Workflow value reference can supply the array; inspect the literal-array arm.
type WorkflowDraftEditOpsMustRemainConcrete = AssertTrue<Concrete<Extract<SchemaInputs['workflow.authoring.draft.edit']['ops'], readonly unknown[]>[number]>>;
type WorkflowSavedEditOpsMustRemainConcrete = AssertTrue<Concrete<Extract<SchemaInputs['workflow.definition.edit']['ops'], readonly unknown[]>[number]>>;
