import type { SupportedLanguage } from '../_all';

const words = {
    en: ['From a template…', 'Find a Bot template, then make it your own.', 'Search Bot templates', 'From the Store', 'Shared with you'],
    fr: ['À partir d’un modèle…', 'Trouvez un modèle de Bot et personnalisez-le.', 'Rechercher des modèles de Bot', 'Depuis le Store', 'Partagés avec vous'],
    de: ['Aus einer Vorlage…', 'Finde eine Bot-Vorlage und passe sie an.', 'Bot-Vorlagen suchen', 'Aus dem Store', 'Mit dir geteilt'],
    es: ['Desde una plantilla…', 'Busca una plantilla de Bot y hazla tuya.', 'Buscar plantillas de Bot', 'Desde la tienda', 'Compartidas contigo'],
    it: ['Da un modello…', 'Trova un modello di Bot e personalizzalo.', 'Cerca modelli di Bot', 'Dallo Store', 'Condivisi con te'],
    pt: ['A partir de um modelo…', 'Encontra um modelo de Bot e personaliza-o.', 'Pesquisar modelos de Bot', 'Da loja', 'Partilhados contigo'],
    ca: ['Des d’una plantilla…', 'Troba una plantilla de Bot i fes-la teva.', 'Cerca plantilles de Bot', 'Des de la botiga', 'Compartides amb tu'],
    ja: ['テンプレートから…', 'Botテンプレートを見つけて自分用に作成します。', 'Botテンプレートを検索', 'ストアから', '共有されたテンプレート'],
    ru: ['Из шаблона…', 'Найдите шаблон Бота и настройте его для себя.', 'Поиск шаблонов Бота', 'Из магазина', 'Доступные вам'],
    pl: ['Z szablonu…', 'Znajdź szablon Bota i dostosuj go do siebie.', 'Szukaj szablonów Bota', 'Ze sklepu', 'Udostępnione Tobie'],
    'zh-Hans': ['从模板创建…', '查找 Bot 模板，创建自己的 Bot。', '搜索 Bot 模板', '来自商店', '与你共享'],
    'zh-Hant': ['從範本建立…', '尋找 Bot 範本，建立自己的 Bot。', '搜尋 Bot 範本', '來自商店', '與你分享'],
} as const satisfies Record<SupportedLanguage, readonly string[]>;

export function botStoreTranslations(language: SupportedLanguage) {
    const [fromTemplate, storeDescription, storeSearch, fromStore, sharedWithYou] = words[language];
    return { fromTemplate, storeDescription, storeSearch, fromStore, sharedWithYou };
}
