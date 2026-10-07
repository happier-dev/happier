// Tooling aggregate. Product locale roots import only their locale payload.
import { voiceExternalCredentialApprovalTranslations as ca } from './features/ca';
import { voiceExternalCredentialApprovalTranslations as es } from './features/es';
import { voiceExternalCredentialApprovalTranslations as fr } from './features/fr';
import { voiceExternalCredentialApprovalTranslations as it } from './features/it';
import { voiceExternalCredentialApprovalTranslations as ja } from './features/ja';
import { voiceExternalCredentialApprovalTranslations as pl } from './features/pl';
import { voiceExternalCredentialApprovalTranslations as pt } from './features/pt';
import { voiceExternalCredentialApprovalTranslations as ru } from './features/ru';
import { voiceExternalCredentialApprovalTranslations as zh_Hans } from './features/zh-Hans';
import { voiceExternalCredentialApprovalTranslations as zh_Hant } from './features/zh-Hant';

export const voiceExternalCredentialApprovalTranslations = {
    ...ca.voiceExternalCredentialApprovalTranslations,
    ...es.voiceExternalCredentialApprovalTranslations,
    ...fr.voiceExternalCredentialApprovalTranslations,
    ...it.voiceExternalCredentialApprovalTranslations,
    ...ja.voiceExternalCredentialApprovalTranslations,
    ...pl.voiceExternalCredentialApprovalTranslations,
    ...pt.voiceExternalCredentialApprovalTranslations,
    ...ru.voiceExternalCredentialApprovalTranslations,
    ...zh_Hans.voiceExternalCredentialApprovalTranslations,
    ...zh_Hant.voiceExternalCredentialApprovalTranslations,
};
