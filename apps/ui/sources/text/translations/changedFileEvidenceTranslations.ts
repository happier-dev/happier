// Tooling aggregate. Product locale roots import only their locale payload.
import { changedFileEvidenceTranslations as en } from './features/en';
import { changedFileEvidenceTranslations as ca } from './features/ca';
import { changedFileEvidenceTranslations as de } from './features/de';
import { changedFileEvidenceTranslations as es } from './features/es';
import { changedFileEvidenceTranslations as fr } from './features/fr';
import { changedFileEvidenceTranslations as it } from './features/it';
import { changedFileEvidenceTranslations as ja } from './features/ja';
import { changedFileEvidenceTranslations as pl } from './features/pl';
import { changedFileEvidenceTranslations as pt } from './features/pt';
import { changedFileEvidenceTranslations as ru } from './features/ru';
import { changedFileEvidenceTranslations as zh_Hans } from './features/zh-Hans';
import { changedFileEvidenceTranslations as zh_Hant } from './features/zh-Hant';

export const changedFileEvidenceTranslations = {
    ...en.changedFileEvidenceTranslations,
    ...ca.changedFileEvidenceTranslations,
    ...de.changedFileEvidenceTranslations,
    ...es.changedFileEvidenceTranslations,
    ...fr.changedFileEvidenceTranslations,
    ...it.changedFileEvidenceTranslations,
    ...ja.changedFileEvidenceTranslations,
    ...pl.changedFileEvidenceTranslations,
    ...pt.changedFileEvidenceTranslations,
    ...ru.changedFileEvidenceTranslations,
    ...zh_Hans.changedFileEvidenceTranslations,
    ...zh_Hant.changedFileEvidenceTranslations,
};
