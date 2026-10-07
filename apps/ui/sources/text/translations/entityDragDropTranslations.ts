// Tooling aggregate. Product locale roots import only their locale payload.
import { entityDragDropTranslations as en } from './features/en';
import { entityDragDropTranslations as ca } from './features/ca';
import { entityDragDropTranslations as de } from './features/de';
import { entityDragDropTranslations as es } from './features/es';
import { entityDragDropTranslations as fr } from './features/fr';
import { entityDragDropTranslations as it } from './features/it';
import { entityDragDropTranslations as ja } from './features/ja';
import { entityDragDropTranslations as pl } from './features/pl';
import { entityDragDropTranslations as pt } from './features/pt';
import { entityDragDropTranslations as ru } from './features/ru';
import { entityDragDropTranslations as zh_Hans } from './features/zh-Hans';
import { entityDragDropTranslations as zh_Hant } from './features/zh-Hant';

export const entityDragDropTranslations = {
    ...en.entityDragDropTranslations,
    ...ca.entityDragDropTranslations,
    ...de.entityDragDropTranslations,
    ...es.entityDragDropTranslations,
    ...fr.entityDragDropTranslations,
    ...it.entityDragDropTranslations,
    ...ja.entityDragDropTranslations,
    ...pl.entityDragDropTranslations,
    ...pt.entityDragDropTranslations,
    ...ru.entityDragDropTranslations,
    ...zh_Hans.entityDragDropTranslations,
    ...zh_Hant.entityDragDropTranslations,
};
