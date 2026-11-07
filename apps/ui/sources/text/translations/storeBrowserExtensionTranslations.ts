/** Host kind labels shared by Store browse, search, inventory and updates. */
export const storeBrowserExtensionTranslations = {
  en: { title: 'Browser extensions', description: 'Extensions for your managed browser profiles.', search: 'Search browser extensions', word: 'Browser extension' },
  ca: { title: 'Extensions del navegador', description: 'Extensions per als perfils del navegador gestionat.', search: 'Cerca extensions del navegador', word: 'Extensió del navegador' },
  de: { title: 'Browser-Erweiterungen', description: 'Erweiterungen für deine verwalteten Browserprofile.', search: 'Browser-Erweiterungen suchen', word: 'Browser-Erweiterung' },
  es: { title: 'Extensiones del navegador', description: 'Extensiones para tus perfiles del navegador administrado.', search: 'Buscar extensiones del navegador', word: 'Extensión del navegador' },
  fr: { title: 'Extensions de navigateur', description: 'Extensions pour vos profils de navigateur géré.', search: 'Rechercher des extensions', word: 'Extension de navigateur' },
  it: { title: 'Estensioni del browser', description: 'Estensioni per i profili del browser gestito.', search: 'Cerca estensioni del browser', word: 'Estensione del browser' },
  ja: { title: 'ブラウザー拡張機能', description: '管理対象ブラウザーのプロファイルで使う拡張機能。', search: 'ブラウザー拡張機能を検索', word: 'ブラウザー拡張機能' },
  pl: { title: 'Rozszerzenia przeglądarki', description: 'Rozszerzenia dla zarządzanych profili przeglądarki.', search: 'Szukaj rozszerzeń przeglądarki', word: 'Rozszerzenie przeglądarki' },
  pt: { title: 'Extensões do navegador', description: 'Extensões para seus perfis do navegador gerenciado.', search: 'Buscar extensões do navegador', word: 'Extensão do navegador' },
  ru: { title: 'Расширения браузера', description: 'Расширения для управляемых профилей браузера.', search: 'Поиск расширений браузера', word: 'Расширение браузера' },
  zhHans: { title: '浏览器扩展', description: '用于受管浏览器配置文件的扩展。', search: '搜索浏览器扩展', word: '浏览器扩展' },
  zhHant: { title: '瀏覽器擴充功能', description: '用於受管理瀏覽器設定檔的擴充功能。', search: '搜尋瀏覽器擴充功能', word: '瀏覽器擴充功能' },
} as const;

export type StoreBrowserExtensionInstallTranslation = Readonly<{ reviewTitle: string; restartTitle: string; restartBody: string }>;
export const storeBrowserExtensionInstallTranslations = {
  en: {"reviewTitle":"Review extension permissions","restartTitle":"Restart browser profile?","restartBody":"Installing this extension will restart the browser profile and close its open pages."},
  ca: {"reviewTitle":"Revisa els permisos de l’extensió","restartTitle":"Vols reiniciar el perfil del navegador?","restartBody":"Instal·lar aquesta extensió reiniciarà el perfil del navegador i tancarà les pàgines obertes."},
  de: {"reviewTitle":"Erweiterungsberechtigungen prüfen","restartTitle":"Browserprofil neu starten?","restartBody":"Die Installation dieser Erweiterung startet das Browserprofil neu und schließt seine geöffneten Seiten."},
  es: {"reviewTitle":"Revisar permisos de la extensión","restartTitle":"¿Reiniciar el perfil del navegador?","restartBody":"Instalar esta extensión reiniciará el perfil del navegador y cerrará sus páginas abiertas."},
  fr: {"reviewTitle":"Vérifier les autorisations de l’extension","restartTitle":"Redémarrer le profil du navigateur ?","restartBody":"L’installation de cette extension redémarrera le profil du navigateur et fermera ses pages ouvertes."},
  it: {"reviewTitle":"Controlla i permessi dell’estensione","restartTitle":"Riavviare il profilo del browser?","restartBody":"Installare questa estensione riavvierà il profilo del browser e chiuderà le pagine aperte."},
  ja: {"reviewTitle":"拡張機能の権限を確認","restartTitle":"ブラウザープロファイルを再起動しますか？","restartBody":"この拡張機能をインストールすると、ブラウザープロファイルが再起動し、開いているページが閉じられます。"},
  pl: {"reviewTitle":"Sprawdź uprawnienia rozszerzenia","restartTitle":"Uruchomić ponownie profil przeglądarki?","restartBody":"Instalacja tego rozszerzenia uruchomi ponownie profil przeglądarki i zamknie otwarte strony."},
  pt: {"reviewTitle":"Revisar permissões da extensão","restartTitle":"Reiniciar o perfil do navegador?","restartBody":"Instalar esta extensão reiniciará o perfil do navegador e fechará suas páginas abertas."},
  ru: {"reviewTitle":"Проверьте разрешения расширения","restartTitle":"Перезапустить профиль браузера?","restartBody":"Установка этого расширения перезапустит профиль браузера и закроет открытые страницы."},
  zhHans: {"reviewTitle":"检查扩展权限","restartTitle":"重启浏览器配置文件？","restartBody":"安装此扩展将重启浏览器配置文件并关闭其打开的页面。"},
  zhHant: {"reviewTitle":"檢查擴充功能權限","restartTitle":"重新啟動瀏覽器設定檔？","restartBody":"安裝此擴充功能將重新啟動瀏覽器設定檔並關閉其開啟的頁面。"},
} satisfies Record<string, StoreBrowserExtensionInstallTranslation>;
