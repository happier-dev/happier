import type { SupportedLanguage } from '../_all';

const words = {
    en: ['From a template…', 'Find a Bot template, then make it your own.', 'Search Bot templates', 'From the Store', 'Shared with you', 'Templates people on this server gave you a copy of.', 'Published as plugins. Each one starts a Bot of your own.'],
    fr: ['À partir d’un modèle…', 'Trouvez un modèle de Bot et personnalisez-le.', 'Rechercher des modèles de Bot', 'Depuis le Store', 'Partagés avec vous', 'Modèles dont des personnes de ce serveur vous ont donné une copie.', 'Publiés comme plugins. Chacun crée votre propre Bot.'],
    de: ['Aus einer Vorlage…', 'Finde eine Bot-Vorlage und passe sie an.', 'Bot-Vorlagen suchen', 'Aus dem Store', 'Mit dir geteilt', 'Vorlagen, von denen dir Personen auf diesem Server eine Kopie gegeben haben.', 'Als Plugins veröffentlicht. Jede startet deinen eigenen Bot.'],
    es: ['Desde una plantilla…', 'Busca una plantilla de Bot y hazla tuya.', 'Buscar plantillas de Bot', 'Desde la tienda', 'Compartidas contigo', 'Plantillas de las que alguien de este servidor te dio una copia.', 'Publicadas como plugins. Cada una crea un Bot propio.'],
    it: ['Da un modello…', 'Trova un modello di Bot e personalizzalo.', 'Cerca modelli di Bot', 'Dallo Store', 'Condivisi con te', 'Modelli di cui qualcuno su questo server ti ha dato una copia.', 'Pubblicati come plugin. Ognuno avvia un Bot tutto tuo.'],
    pt: ['A partir de um modelo…', 'Encontra um modelo de Bot e personaliza-o.', 'Pesquisar modelos de Bot', 'Da loja', 'Partilhados contigo', 'Modelos de que alguém neste servidor te deu uma cópia.', 'Publicados como plugins. Cada um cria um Bot teu.'],
    ca: ['Des d’una plantilla…', 'Troba una plantilla de Bot i fes-la teva.', 'Cerca plantilles de Bot', 'Des de la botiga', 'Compartides amb tu', 'Plantilles de les quals algú d’aquest servidor t’ha donat una còpia.', 'Publicades com a plugins. Cadascuna crea un Bot teu.'],
    ja: ['テンプレートから…', 'Botテンプレートを見つけて自分用に作成します。', 'Botテンプレートを検索', 'ストアから', '共有されたテンプレート', 'このサーバーの人からコピーを受け取ったテンプレートです。', 'プラグインとして公開されています。それぞれ自分専用のBotを作成します。'],
    ru: ['Из шаблона…', 'Найдите шаблон Бота и настройте его для себя.', 'Поиск шаблонов Бота', 'Из магазина', 'Доступные вам', 'Шаблоны, копию которых вам дали люди на этом сервере.', 'Опубликованы как плагины. Каждый создаёт вашего собственного Бота.'],
    pl: ['Z szablonu…', 'Znajdź szablon Bota i dostosuj go do siebie.', 'Szukaj szablonów Bota', 'Ze sklepu', 'Udostępnione Tobie', 'Szablony, których kopię dały Ci osoby na tym serwerze.', 'Opublikowane jako wtyczki. Każdy tworzy Twojego własnego Bota.'],
    'zh-Hans': ['从模板创建…', '查找 Bot 模板，创建自己的 Bot。', '搜索 Bot 模板', '来自商店', '与你共享', '此服务器上的人给你的模板副本。', '以插件形式发布。每个都会创建你自己的 Bot。'],
    'zh-Hant': ['從範本建立…', '尋找 Bot 範本，建立自己的 Bot。', '搜尋 Bot 範本', '來自商店', '與你分享', '此伺服器上的人給你的範本副本。', '以外掛形式發佈。每個都會建立你自己的 Bot。'],
} as const satisfies Record<SupportedLanguage, readonly string[]>;

export function botStoreTranslations(language: SupportedLanguage) {
    const [fromTemplate, storeDescription, storeSearch, fromStore, sharedWithYou, sharedWithYouDescription, fromStoreDescription] = words[language];
    return { fromTemplate, storeDescription, storeSearch, fromStore, sharedWithYou, sharedWithYouDescription, fromStoreDescription };
}
