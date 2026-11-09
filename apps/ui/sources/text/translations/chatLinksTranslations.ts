import type { SupportedLanguage } from '../_types';

type ChatLinksCopy = Readonly<{ title: string; description: string; browser: string; embedded: string; managed: string }>;

export const chatLinksTranslations = {
  "en": {"title": "Open links from chats in", "description": "Choose where chat links open on this device. Machine localhost links always open in the app.", "browser": "Your browser", "embedded": "Embedded", "managed": "Managed"},
  "fr": {"title": "Ouvrir les liens des chats dans", "description": "Choisissez où ouvrir les liens sur cet appareil. Les liens localhost de la machine restent dans l’application.", "browser": "Votre navigateur", "embedded": "Intégré", "managed": "Géré"},
  "de": {"title": "Chat-Links öffnen in", "description": "Wähle, wo Chat-Links auf diesem Gerät geöffnet werden. Localhost-Links der Maschine bleiben in der App.", "browser": "Dein Browser", "embedded": "Eingebettet", "managed": "Verwaltet"},
  "es": {"title": "Abrir enlaces de chats en", "description": "Elige dónde abrir enlaces en este dispositivo. Los enlaces localhost de la máquina se abren en la aplicación.", "browser": "Tu navegador", "embedded": "Integrado", "managed": "Gestionado"},
  "it": {"title": "Apri i link delle chat in", "description": "Scegli dove aprire i link su questo dispositivo. I link localhost della macchina si aprono sempre nell’app.", "browser": "Il tuo browser", "embedded": "Integrato", "managed": "Gestito"},
  "pt": {"title": "Abrir links dos chats em", "description": "Escolha onde abrir links neste dispositivo. Links localhost da máquina sempre abrem no aplicativo.", "browser": "Seu navegador", "embedded": "Integrado", "managed": "Gerenciado"},
  "ca": {"title": "Obre els enllaços dels xats a", "description": "Tria on obrir els enllaços en aquest dispositiu. Els enllaços localhost de la màquina sempre s’obren a l’aplicació.", "browser": "El teu navegador", "embedded": "Integrat", "managed": "Gestionat"},
  "pl": {"title": "Otwieraj linki z czatów w", "description": "Wybierz, gdzie otwierać linki na tym urządzeniu. Linki localhost maszyny zawsze otwierają się w aplikacji.", "browser": "Twoja przeglądarka", "embedded": "Wbudowana", "managed": "Zarządzana"},
  "ru": {"title": "Открывать ссылки из чатов в", "description": "Выберите, где открывать ссылки на этом устройстве. Ссылки localhost машины всегда открываются в приложении.", "browser": "Ваш браузер", "embedded": "Встроенный", "managed": "Управляемый"},
  "ja": {"title": "チャットのリンクを開く場所", "description": "このデバイスでリンクを開く場所を選びます。マシンの localhost リンクは常にアプリ内で開きます。", "browser": "端末のブラウザ", "embedded": "埋め込み", "managed": "管理対象"},
  "zh-Hans": {"title": "聊天链接打开方式", "description": "选择此设备上的链接打开方式。机器的 localhost 链接始终在应用内打开。", "browser": "你的浏览器", "embedded": "内嵌", "managed": "托管"},
  "zh-Hant": {"title": "聊天連結開啟方式", "description": "選擇此裝置上的連結開啟方式。機器的 localhost 連結一律在應用程式內開啟。", "browser": "你的瀏覽器", "embedded": "內嵌", "managed": "託管"},
} as const satisfies Record<SupportedLanguage, ChatLinksCopy>;
